#!/usr/bin/env bash
# The production VPS on AWS: one EC2 instance in ap-south-1 (Mumbai) with an Elastic IP, a security group
# and an SSH key pair. Every resource is tagged Project=urumi (and named urumi-vps), and this script only
# ever looks up, changes or deletes resources that carry that tag.
#
#   plan          what `up` would create, using read-only lookups only (creates and changes nothing)
#   up            create whatever is missing (safe to re-run), then print the IP and the DNS record to add
#   status        instance state, Elastic IP, the SSH rule vs your current IP, and what public DNS answers
#   allow-my-ip   point the SSH rule (port 22) at your current public IP/32 (run it when your IP changed)
#   stop | start  stop the instance to save credits / start it again (Elastic IP, disk and data stay)
#   down          delete everything tagged Project=urumi: instance, disk, Elastic IP, security group and
#                 key pair (asks you to type a confirmation first)
#
# What `up` builds:
#   - key pair urumi-vps (ed25519). The private key is written to VPS_SSH_KEY (~/.ssh/urumi-vps.pem, mode
#     600) and never printed. AWS keeps only the public half, so it cannot be downloaded again later.
#   - security group urumi-vps: 80 and 443 from anywhere (IPv4 and IPv6), 22 only from your IP/32.
#     6443 (the Kubernetes API) is never opened: kubectl reaches it through an SSH tunnel (tunnel.sh).
#   - instance urumi-vps: t3.large, the latest Ubuntu 24.04 amd64 AMI (Canonical's public SSM parameter),
#     40 GB encrypted gp3 root disk that survives an accidental termination (DeleteOnTermination=false),
#     IMDSv2 only with hop limit 1, termination protection on, no IAM role.
#   - an Elastic IP associated with the instance, so the address (and the DNS record) survive stop/start.
#   - (local, not in AWS) the instance's SSH host key, read from its console output through the EC2 API and
#     pinned in .vps/known_hosts, so even the first ssh to it is checked (scripts/vps/common.sh).
#
# Needs: AWS CLI v2 with credentials (e.g. `export AWS_PROFILE=aws-main`), curl, ssh-keygen.
# Works in WSL/Linux/macOS and in Git Bash on Windows. Settings (environment):
#   URUMI_REGION=ap-south-1  URUMI_INSTANCE_TYPE=t3.large  URUMI_DISK_GB=40  VPS_SSH_KEY=~/.ssh/urumi-vps.pem
# The region is passed on every call, so an AWS_REGION/AWS_DEFAULT_REGION set elsewhere never redirects it.
set -euo pipefail
# Git Bash on Windows rewrites arguments that look like Unix paths ("/aws/service/...", "/dev/sda1") into
# Windows paths before it starts aws.exe. This turns that off; it means nothing anywhere else.
export MSYS_NO_PATHCONV=1
export AWS_PAGER=""   # never pipe output into a pager

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/vps/common.sh
. "$ROOT/scripts/vps/common.sh"

REGION="${URUMI_REGION:-ap-south-1}"
INSTANCE_TYPE="${URUMI_INSTANCE_TYPE:-t3.large}"
DISK_GB="${URUMI_DISK_GB:-40}"
NAME=urumi-vps       # Name tag of every resource; also the key pair and security group name
PROJECT=urumi        # the tag that marks our resources: nothing without it is ever touched
AMI_PARAM=/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id
TAGS="{Key=Project,Value=$PROJECT},{Key=Name,Value=$NAME}"   # for --tag-specifications
DNS_NAME="*.urumi"   # record name inside the humanslop.in zone
HOSTS=(store.urumi.humanslop.in app.urumi.humanslop.in)

# --- AWS helpers ---------------------------------------------------------------------------------
# aws in our region with plain-text output. An empty result comes back as "" (the CLI prints "None").
# "|| return": these helpers run inside $(...), where bash switches `set -e` off, so a failed call must
# hand its exit code up explicitly (the caller's assignment then stops the script).
awsq() {
  local out
  out="$(aws --region "$REGION" --output text "$@")" || return
  [ "$out" = None ] && out=""
  printf '%s' "$out"
}

vpc_id()      { awsq ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId'; }
ami_id()      { awsq ssm get-parameter --name "$AMI_PARAM" --query Parameter.Value; }
key_pair_id() { awsq ec2 describe-key-pairs --filters "Name=key-name,Values=$NAME" --query 'KeyPairs[0].KeyPairId'; }
sg_id() {
  awsq ec2 describe-security-groups --filters "Name=group-name,Values=$NAME" "Name=tag:Project,Values=$PROJECT" \
    --query 'SecurityGroups[0].GroupId'
}
# Our instance, unless it is terminated (terminated instances stay visible for about an hour).
instance_id() {
  awsq ec2 describe-instances \
    --filters "Name=tag:Project,Values=$PROJECT" "Name=tag:Name,Values=$NAME" \
              Name=instance-state-name,Values=pending,running,stopping,stopped \
    --query 'Reservations[0].Instances[0].InstanceId'
}
instance_state() { awsq ec2 describe-instances --instance-ids "$1" --query 'Reservations[0].Instances[0].State.Name'; }
eip_alloc_id()   { awsq ec2 describe-addresses --filters "Name=tag:Project,Values=$PROJECT" --query 'Addresses[0].AllocationId'; }
eip_ip()         { awsq ec2 describe-addresses --allocation-ids "$1" --query 'Addresses[0].PublicIp'; }
eip_instance()   { awsq ec2 describe-addresses --allocation-ids "$1" --query 'Addresses[0].InstanceId'; }
# One "<rule-id> <cidr>" line per inbound rule on port 22. (The backticks are JMESPath literals.)
# shellcheck disable=SC2016
ssh_rules() {
  awsq ec2 describe-security-group-rules --filters "Name=group-id,Values=$1" \
    --query 'SecurityGroupRules[?IsEgress==`false` && FromPort==`22`].[SecurityGroupRuleId,CidrIpv4]'
}
# True when the security group already lets IP/32 in on port 22.
ssh_allows() { ssh_rules "$1" | awk -v want="$2/32" '$2 == want { found = 1 } END { exit !found }'; }

# Your public IPv4 address as AWS sees it (the SSH rule allows exactly this /32).
my_ip() {
  local ip
  ip="$(curl -fsS --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')" || return
  [[ "$ip" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || { echo "error: could not detect your public IP (got '$ip')" >&2; return 1; }
  printf '%s' "$ip"
}

# The A records public DNS returns for a name, via Cloudflare's DNS-over-HTTPS: no dig/nslookup needed,
# and the answer is what Let's Encrypt will see rather than a local cache.
public_a_records() {
  curl -fsS --max-time 10 -H 'accept: application/dns-json' "https://cloudflare-dns.com/dns-query?name=$1&type=A" \
    | grep -oE '"data":"[0-9.]+"' | cut -d'"' -f4 | tr '\n' ' ' || true
}

header() {
  local arn
  arn="$(awsq sts get-caller-identity --query Arn)" || die "AWS credentials do not work (aws sts get-caller-identity failed)"
  echo "AWS identity: $arn   region: $REGION"
}

# --- plan (read-only) ----------------------------------------------------------------------------
cmd_plan() {
  header
  local vpc ami ami_name offered key sg inst eip ip
  vpc="$(vpc_id)"
  [ -n "$vpc" ] || die "no default VPC in $REGION (this script launches into the default VPC)"
  ami="$(ami_id)"
  ami_name="$(awsq ec2 describe-images --image-ids "$ami" --query 'Images[0].Name')"
  offered="$(awsq ec2 describe-instance-type-offerings --location-type region \
    --filters "Name=instance-type,Values=$INSTANCE_TYPE" --query 'InstanceTypeOfferings[0].InstanceType')"
  [ -n "$offered" ] || die "$INSTANCE_TYPE is not offered in $REGION"
  ip="$(my_ip)"
  key="$(key_pair_id)"; sg="$(sg_id)"; inst="$(instance_id)"; eip="$(eip_alloc_id)"

  step "plan (nothing below is created or changed by this command)"
  echo "  default VPC:     $vpc"
  echo "  AMI:             $ami ($ami_name)"
  if [ -n "$key" ]; then
    echo "  key pair:        exists ($NAME, $key); private key $VPS_SSH_KEY: $([ -f "$VPS_SSH_KEY" ] && echo present || echo MISSING)"
  elif [ -f "$VPS_SSH_KEY" ]; then
    echo "  key pair:        would IMPORT the public half of $VPS_SSH_KEY as $NAME"
  else
    echo "  key pair:        would CREATE $NAME (ed25519); private key -> $VPS_SSH_KEY (mode 600, never printed)"
  fi
  if [ -n "$sg" ]; then
    echo "  security group:  exists ($sg); SSH allowed from: $(ssh_rules "$sg" | awk '{print $2}' | tr '\n' ' ')"
  else
    echo "  security group:  would CREATE $NAME in $vpc: tcp 80,443 from 0.0.0.0/0 and ::/0; tcp 22 from $ip/32"
  fi
  if [ -n "$inst" ]; then
    echo "  instance:        exists ($inst, $(instance_state "$inst"))"
  else
    echo "  instance:        would LAUNCH $INSTANCE_TYPE from $ami: ${DISK_GB} GB gp3 root (encrypted, kept on"
    echo "                   termination), IMDSv2 required + hop limit 1, termination protection, no IAM role"
  fi
  if [ -n "$eip" ]; then
    echo "  Elastic IP:      exists ($(eip_ip "$eip"), $eip), attached to: $(eip_instance "$eip")"
  else
    echo "  Elastic IP:      would ALLOCATE one and associate it with the instance"
  fi
  echo "  tags:            Project=$PROJECT, Name=$NAME on all of the above (and the root volume)"
  echo "  your IP:         $ip (the SSH rule's /32)"
  cat <<EOF

Cost in $REGION (on-demand list prices, Oct 2026):
  running   t3.large \$0.0896/h + public IPv4 \$0.005/h + ${DISK_GB} GB gp3 at \$0.0912/GB-month  ~ \$2.4 per day
  stopped   public IPv4 + disk only                                                      ~ \$0.25 per day
  t3 runs in "unlimited" CPU-credit mode by default: only a CPU average above the 30 % baseline costs
  extra (\$0.05 per vCPU-hour). This stack idles far below that.
Create it with:  bash scripts/vps/provision-aws.sh up
EOF
}

# --- up ------------------------------------------------------------------------------------------
# The ensure_* steps set these globals (instead of printing ids for $(...), where `set -e` is off).
SG=""; INST=""; PUBLIC_IP=""

ensure_key_pair() {
  if [ -n "$(key_pair_id)" ]; then
    [ -f "$VPS_SSH_KEY" ] || die "key pair $NAME exists in AWS but $VPS_SSH_KEY is not here. AWS cannot hand out the
       private key again: point VPS_SSH_KEY at your copy, or (if no instance uses it) delete the key pair in
       the EC2 console and re-run this to make a new one."
    echo "  = key pair $NAME (private key $VPS_SSH_KEY)"
  elif [ -f "$VPS_SSH_KEY" ]; then
    # A private key but no key pair in AWS: register its public half (derived locally, never uploaded twice).
    awsq ec2 import-key-pair --key-name "$NAME" \
      --public-key-material "$(ssh-keygen -y -f "$VPS_SSH_KEY" | base64 | tr -d '\n')" \
      --tag-specifications "ResourceType=key-pair,Tags=[$TAGS]" --query KeyPairId >/dev/null
    echo "  + key pair $NAME (imported the public key of $VPS_SSH_KEY)"
  else
    local dir tmp
    dir="$(dirname "$VPS_SSH_KEY")"
    mkdir -p "$dir"
    chmod 700 "$dir" 2>/dev/null || true
    tmp="$VPS_SSH_KEY.partial"
    # The private key goes from the API response straight into a file only we can read; it is never
    # printed. tr drops the \r the Windows build of the CLI puts on every line (ssh rejects those keys),
    # and the final printf restores the trailing newline that $(...) inside awsq strips.
    if ! ( umask 077
           awsq ec2 create-key-pair --key-name "$NAME" --key-type ed25519 --key-format pem \
             --tag-specifications "ResourceType=key-pair,Tags=[$TAGS]" --query KeyMaterial | tr -d '\r' > "$tmp"
           printf '\n' >> "$tmp" ); then
      rm -f "$tmp"
      die "could not create key pair $NAME"
    fi
    mv "$tmp" "$VPS_SSH_KEY"
    chmod 600 "$VPS_SSH_KEY"
    ssh-keygen -l -f "$VPS_SSH_KEY" >/dev/null || die "the key written to $VPS_SSH_KEY is not a valid private key"
    echo "  + key pair $NAME (private key saved to $VPS_SSH_KEY, mode 600)"
  fi
}

# Opens one TCP port to the world, IPv4 and IPv6 separately. A rule that is already there is fine.
open_port_to_world() { # port
  local port=$1 range err
  err="$(mktemp)"
  for range in '"IpRanges":[{"CidrIp":"0.0.0.0/0","Description":"web from anywhere"}]' \
               '"Ipv6Ranges":[{"CidrIpv6":"::/0","Description":"web from anywhere"}]'; do
    if ! aws --region "$REGION" ec2 authorize-security-group-ingress --group-id "$SG" \
         --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":$port,\"ToPort\":$port,$range}]" \
         --tag-specifications "ResourceType=security-group-rule,Tags=[$TAGS]" >/dev/null 2>"$err"; then
      grep -q 'InvalidPermission.Duplicate' "$err" || { cat "$err" >&2; rm -f "$err"; die "could not open port $port"; }
    fi
  done
  rm -f "$err"
  echo "  = port $port open to 0.0.0.0/0 and ::/0"
}

# Makes IP/32 the only source allowed on port 22.
set_ssh_rule() { # ip
  local ip=$1 rule cidr
  while read -r rule cidr; do
    [ -n "$rule" ] && [ "$cidr" != "$ip/32" ] || continue
    aws --region "$REGION" ec2 revoke-security-group-ingress --group-id "$SG" --security-group-rule-ids "$rule" >/dev/null
    echo "  - SSH from $cidr removed"
  done <<< "$(ssh_rules "$SG")"
  if ssh_allows "$SG" "$ip"; then
    echo "  = SSH from $ip/32"
  else
    aws --region "$REGION" ec2 authorize-security-group-ingress --group-id "$SG" \
      --ip-permissions "[{\"IpProtocol\":\"tcp\",\"FromPort\":22,\"ToPort\":22,\"IpRanges\":[{\"CidrIp\":\"$ip/32\",\"Description\":\"ssh from the operator\"}]}]" \
      --tag-specifications "ResourceType=security-group-rule,Tags=[$TAGS]" >/dev/null
    echo "  + SSH from $ip/32"
  fi
}

ensure_security_group() { # vpc ip
  local vpc=$1 ip=$2
  SG="$(sg_id)"
  if [ -z "$SG" ]; then
    SG="$(awsq ec2 create-security-group --group-name "$NAME" --vpc-id "$vpc" \
      --description "urumi VPS: web from anywhere, SSH from the operator only" \
      --tag-specifications "ResourceType=security-group,Tags=[$TAGS]" --query GroupId)"
    echo "  + security group $SG"
  else
    echo "  = security group $SG"
  fi
  open_port_to_world 80
  open_port_to_world 443
  set_ssh_rule "$ip"
}

ensure_instance() { # ami
  local ami=$1 state root_dev
  INST="$(instance_id)"
  if [ -n "$INST" ]; then
    state="$(instance_state "$INST")"
    echo "  = instance $INST ($state)"
    case "$state" in stopping|stopped) die "instance $INST is $state; start it with: $0 start" ;; esac
  else
    root_dev="$(awsq ec2 describe-images --image-ids "$ami" --query 'Images[0].RootDeviceName')"
    INST="$(awsq ec2 run-instances --image-id "$ami" --instance-type "$INSTANCE_TYPE" --count 1 \
      --key-name "$NAME" --security-group-ids "$SG" \
      --block-device-mappings "[{\"DeviceName\":\"$root_dev\",\"Ebs\":{\"VolumeSize\":$DISK_GB,\"VolumeType\":\"gp3\",\"Encrypted\":true,\"DeleteOnTermination\":false}}]" \
      --metadata-options HttpTokens=required,HttpPutResponseHopLimit=1,HttpEndpoint=enabled \
      --disable-api-termination \
      --tag-specifications "ResourceType=instance,Tags=[$TAGS]" "ResourceType=volume,Tags=[$TAGS]" \
      --query 'Instances[0].InstanceId')"
    echo "  + instance $INST ($INSTANCE_TYPE); waiting until it runs..."
  fi
  aws --region "$REGION" ec2 wait instance-running --instance-ids "$INST"
}

ensure_elastic_ip() {
  local alloc attached
  alloc="$(eip_alloc_id)"
  if [ -z "$alloc" ]; then
    alloc="$(awsq ec2 allocate-address --domain vpc \
      --tag-specifications "ResourceType=elastic-ip,Tags=[$TAGS]" --query AllocationId)"
    echo "  + Elastic IP $(eip_ip "$alloc")"
  fi
  attached="$(eip_instance "$alloc")"
  if [ "$attached" = "$INST" ]; then
    echo "  = Elastic IP $(eip_ip "$alloc") on $INST"
  else
    [ -z "$attached" ] || die "Elastic IP $alloc is attached to $attached, not to $INST; fix that in the console"
    aws --region "$REGION" ec2 associate-address --instance-id "$INST" --allocation-id "$alloc" >/dev/null
    echo "  + Elastic IP $(eip_ip "$alloc") associated with $INST"
  fi
  PUBLIC_IP="$(eip_ip "$alloc")"
}

# --- SSH host key, pinned out of band ----------------------------------------------------------------
# Without this, the first ssh to a new machine trusts whatever key answers ("trust on first use"): someone
# on your network path at that moment could pose as the VPS, and kubeconfig.sh and deploy.sh (every Secret
# from .env) would then talk to them. cloud-init prints the instance's host keys to its serial console on
# the first boot, and we read that console through the EC2 API: HTTPS with our AWS credentials, a channel
# such an attacker does not control. The ed25519 key goes into VPS_KNOWN_HOSTS, which is the only key
# common.sh's ssh options accept. A comment line records the instance, so a replaced instance (new keys,
# same Elastic IP) is pinned again and a stop/start (same keys) is not.
# Returns 1 if the console shows no key (cloud-init prints it about a minute after the first boot).
pin_host_key() { # instance-id ip [attempts, 10 s apart; default 30]
  local inst=$1 ip=$2 tries=${3:-30} key="" attempt
  if [ -f "$VPS_KNOWN_HOSTS" ] && grep -qx "# instance $inst" "$VPS_KNOWN_HOSTS" \
     && grep -qF "$ip ssh-ed25519 " "$VPS_KNOWN_HOSTS"; then
    echo "  = host key of $inst pinned in $VPS_KNOWN_HOSTS"
    return 0
  fi
  echo "  reading the SSH host key from the console output of $inst..."
  for attempt in $(seq 1 "$tries"); do
    # --latest: the live console buffer (Nitro instances such as t3). The block between the two markers holds
    # one "<type> <base64> <comment>" line per key; grep -o keeps exactly the ed25519 type and key.
    key="$(awsq ec2 get-console-output --instance-id "$inst" --latest --query Output | tr -d '\r' \
      | sed -n '/-----BEGIN SSH HOST KEY KEYS-----/,/-----END SSH HOST KEY KEYS-----/p' \
      | grep -oE 'ssh-ed25519 [A-Za-z0-9+/]+=*' | head -n 1)" || true
    [ -n "$key" ] && break
    [ "$attempt" -lt "$tries" ] && sleep 10
  done
  [ -n "$key" ] || return 1
  mkdir -p "$(dirname "$VPS_KNOWN_HOSTS")"
  printf '# instance %s\n%s %s\n' "$inst" "$ip" "$key" > "$VPS_KNOWN_HOSTS"
  echo "  + host key pinned in $VPS_KNOWN_HOSTS: $(ssh-keygen -l -f "$VPS_KNOWN_HOSTS" | awk '{print $2, $4}')"
}

print_next_steps() {
  cat <<EOF

VPS ready: $PUBLIC_IP   (host key pinned in $VPS_KNOWN_HOSTS)

DNS: in Cloudflare, zone humanslop.in -> DNS -> Add record
  Type A   Name $DNS_NAME   IPv4 address $PUBLIC_IP   Proxy status: DNS only (grey cloud)   TTL Auto
  Grey cloud on purpose: TLS ends on our own Traefik with the Let's Encrypt certificate (HTTP-01 reaches it
  directly), and no proxy buffers or inspects the MCP and SSE traffic.
  Check that it resolves:  bash scripts/vps/provision-aws.sh status

Next (docs/VPS.md):
  export VPS_HOST=$PUBLIC_IP
  bash scripts/vps/bootstrap.sh       (runs bootstrap-k3s.sh on the VPS, over ssh with the pinned key)
  bash scripts/vps/kubeconfig.sh      then, in a second terminal:  bash scripts/vps/tunnel.sh
EOF
  if command -v cygpath >/dev/null; then
    # Git Bash on Windows: kubectl, helm and the tunnel run in WSL, which has its own ~/.ssh.
    echo
    echo "Windows: copy the key into WSL once (in a WSL shell):"
    echo "  install -m 600 \"\$(wslpath '$(cygpath -m "$VPS_SSH_KEY")')\" ~/.ssh/$(basename "$VPS_SSH_KEY")"
  fi
}

cmd_up() {
  header
  need ssh-keygen
  local vpc ami ip
  vpc="$(vpc_id)"
  [ -n "$vpc" ] || die "no default VPC in $REGION"
  ami="$(ami_id)"
  ip="$(my_ip)"
  step "key pair";       ensure_key_pair
  step "security group"; ensure_security_group "$vpc" "$ip"
  step "instance";       ensure_instance "$ami"
  step "Elastic IP";     ensure_elastic_ip
  step "SSH host key"
  pin_host_key "$INST" "$PUBLIC_IP" || die "the console output of $INST shows no SSH host key yet. Wait a minute and
       run: $0 status   (it pins the key). Do not fall back to accepting the key on first connect."
  print_next_steps
}

# --- status, allow-my-ip, stop, start ------------------------------------------------------------
cmd_status() {
  header
  local inst sg alloc ip="" me host records
  inst="$(instance_id)"; sg="$(sg_id)"; alloc="$(eip_alloc_id)"
  me="$(my_ip)"
  if [ -n "$inst" ]; then
    echo "instance:    $inst  $(awsq ec2 describe-instances --instance-ids "$inst" \
      --query 'Reservations[0].Instances[0].[State.Name,InstanceType,Placement.AvailabilityZone,LaunchTime]' | tr '\t' ' ')"
  else
    echo "instance:    none (create it: $0 up)"
  fi
  if [ -n "$alloc" ]; then
    ip="$(eip_ip "$alloc")"
    echo "Elastic IP:  $ip (attached to: $(eip_instance "$alloc"))"
  else
    echo "Elastic IP:  none"
  fi
  # Pins the host key if it is not pinned yet (one look at the console, no waiting).
  if [ -n "$inst" ] && [ -n "$ip" ] && [ "$(instance_state "$inst")" = running ]; then
    echo "SSH host key:"
    pin_host_key "$inst" "$ip" 1 \
      || echo "  not in the console output (yet): cloud-init prints it about a minute after the first boot; run status again"
  fi
  if [ -n "$sg" ]; then
    echo "SSH allowed: $(ssh_rules "$sg" | awk '{print $2}' | tr '\n' ' ')(your IP now: $me)"
    ssh_allows "$sg" "$me" || echo "             -> your IP changed: run  $0 allow-my-ip"
  fi
  for host in "${HOSTS[@]}"; do
    records="$(public_a_records "$host")"
    if [ -n "$ip" ] && [ "${records% }" = "$ip" ]; then
      echo "DNS:         $host -> $ip (ok)"
    else
      echo "DNS:         $host -> ${records:-nothing} (expected ${ip:-the Elastic IP}: record A $DNS_NAME, DNS only)"
    fi
  done
}

cmd_allow_my_ip() {
  header
  SG="$(sg_id)"
  [ -n "$SG" ] || die "no security group $NAME (create it: $0 up)"
  set_ssh_rule "$(my_ip)"
}

cmd_stop() {
  header
  local inst
  inst="$(instance_id)"
  [ -n "$inst" ] || die "no instance"
  aws --region "$REGION" ec2 stop-instances --instance-ids "$inst" >/dev/null
  echo "stopping $inst..."
  aws --region "$REGION" ec2 wait instance-stopped --instance-ids "$inst"
  echo "stopped. Still billed while stopped: the disk and the Elastic IP (~\$0.25/day). Start: $0 start"
}

cmd_start() {
  header
  local inst
  inst="$(instance_id)"
  [ -n "$inst" ] || die "no instance (create it: $0 up)"
  aws --region "$REGION" ec2 start-instances --instance-ids "$inst" >/dev/null
  echo "starting $inst..."
  aws --region "$REGION" ec2 wait instance-running --instance-ids "$inst"
  echo "running. k3s starts by itself; give the pods 1-2 minutes, then (re)start scripts/vps/tunnel.sh."
}

# --- down ----------------------------------------------------------------------------------------
cmd_down() {
  header
  local inst alloc sg key volumes answer vol attempt
  inst="$(instance_id)"; alloc="$(eip_alloc_id)"; sg="$(sg_id)"
  key="$(awsq ec2 describe-key-pairs --filters "Name=key-name,Values=$NAME" "Name=tag:Project,Values=$PROJECT" \
    --query 'KeyPairs[0].KeyPairId')"
  volumes="$(awsq ec2 describe-volumes --filters "Name=tag:Project,Values=$PROJECT" --query 'Volumes[].VolumeId')"
  echo "This deletes, for good (resources tagged Project=$PROJECT only):"
  echo "  instance:       ${inst:-none}"
  echo "  volumes:        ${volumes:-none}   <- ALL store and gateway data (take backups first: docs/OPERATIONS.md)"
  echo "  Elastic IP:     ${alloc:-none}"
  echo "  security group: ${sg:-none}"
  echo "  key pair:       ${key:-none}   (your local copy $VPS_SSH_KEY is left alone)"
  read -r -p "Type 'destroy $NAME' to continue: " answer
  [ "$answer" = "destroy $NAME" ] || die "not confirmed; nothing was deleted"

  if [ -n "$inst" ]; then
    aws --region "$REGION" ec2 modify-instance-attribute --instance-id "$inst" --no-disable-api-termination
    aws --region "$REGION" ec2 terminate-instances --instance-ids "$inst" >/dev/null
    echo "terminating $inst..."
    aws --region "$REGION" ec2 wait instance-terminated --instance-ids "$inst"
    echo "  - instance $inst"
  fi
  # The root volume outlives the instance (DeleteOnTermination=false); it can go once it is detached.
  for vol in $volumes; do
    aws --region "$REGION" ec2 wait volume-available --volume-ids "$vol"
    aws --region "$REGION" ec2 delete-volume --volume-id "$vol"
    echo "  - volume $vol"
  done
  if [ -n "$alloc" ]; then
    aws --region "$REGION" ec2 release-address --allocation-id "$alloc"
    echo "  - Elastic IP $alloc"
  fi
  if [ -n "$sg" ]; then
    # The terminated instance's network interface can hold on to the group for a little while.
    for attempt in $(seq 1 24); do
      if aws --region "$REGION" ec2 delete-security-group --group-id "$sg" 2>/dev/null; then
        echo "  - security group $sg"
        break
      fi
      [ "$attempt" -lt 24 ] || die "could not delete security group $sg (still in use?)"
      sleep 5
    done
  fi
  if [ -n "$key" ]; then
    aws --region "$REGION" ec2 delete-key-pair --key-pair-id "$key"
    echo "  - key pair $NAME"
  fi
  echo "done. Also delete the Cloudflare record ($DNS_NAME A) and, if you like, $VPS_SSH_KEY."
}

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

case "${1:-}" in
  -h|--help|help|"") usage 0 ;;
esac
need aws curl
case "$1" in
  plan)        cmd_plan ;;
  up)          cmd_up ;;
  status)      cmd_status ;;
  allow-my-ip) cmd_allow_my_ip ;;
  stop)        cmd_stop ;;
  start)       cmd_start ;;
  down)        cmd_down ;;
  *)           echo "unknown command: $1" >&2; usage 1 ;;
esac
