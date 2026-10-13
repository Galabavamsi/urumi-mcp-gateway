import { Link } from 'react-router';
import { EmptyState } from '../components/Feedback';

export function NotFoundPage() {
  return (
    <div className="panel">
      <EmptyState
        title="There is no page at this address"
        action={
          <Link to="/servers" className="btn btn-secondary">
            Go to servers
          </Link>
        }
      >
        Check the link, or use the navigation on the left.
      </EmptyState>
    </div>
  );
}
