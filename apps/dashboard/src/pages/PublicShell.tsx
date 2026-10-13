// Frame for the signed-out pages (login, invite): a quiet ink panel that says what this is, and the form.
import type { ReactNode } from 'react';

export function PublicShell({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-screen md:grid-cols-[minmax(320px,5fr)_7fr]">
      <aside className="flex flex-col justify-between bg-ink px-6 py-6 text-[#c9d3da] md:px-12 md:py-12">
        <div className="flex items-center gap-2.5">
          <svg viewBox="0 0 32 32" className="size-8" aria-hidden="true">
            <circle cx="16" cy="16" r="14" fill="none" strokeWidth="1.5" className="stroke-[#3a4954]" />
            <circle cx="16" cy="16" r="8.5" fill="none" strokeWidth="2" className="stroke-[#5fb3cf]" />
            <circle cx="16" cy="16" r="4" className="fill-[#5fb3cf]" />
          </svg>
          <span className="font-display text-xl font-semibold text-white">
            Urumi <span className="font-normal text-[#9fb0bc]">gateway</span>
          </span>
        </div>
        <div className="mt-6 max-w-[34ch] md:mt-0">
          <p className="font-display text-[1.35rem] leading-snug text-white md:text-[2rem]">
            One door between your shop team and its AI tools.
          </p>
          <p className="mt-4 hidden text-[15px] leading-relaxed md:block">
            Claude Code, Cursor and the store agent reach WooCommerce and the other tool servers through here, each
            person with their own key, every call written to the audit log.
          </p>
        </div>
        <p className="mt-10 hidden text-xs text-[#8899a6] md:block">Upstream credentials never leave the gateway.</p>
      </aside>
      <main className="flex items-center justify-center px-4 py-12 md:px-12">
        <div className="w-full max-w-[400px]">{children}</div>
      </main>
    </div>
  );
}
