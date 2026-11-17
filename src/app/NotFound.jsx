import { Link } from 'react-router-dom'
import { Compass } from 'lucide-react'
import { EmptyState } from '../components/ui'

export default function NotFound() {
  return (
    <EmptyState
      icon={Compass}
      title="This area isn’t on the map"
      action={
        <Link to="/dashboard" className="btn btn--primary">
          Back to Command
        </Link>
      }
    >
      The page you opened doesn’t exist or has moved.
    </EmptyState>
  )
}
