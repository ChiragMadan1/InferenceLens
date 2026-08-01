import { Link, useRouteError } from 'react-router-dom'
import { Button } from '../ui/Button'
import { ErrorState } from '../ui/ErrorState'

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return 'An unexpected error occurred.'
}

// Registered as the router's errorElement (FR6). The shell survives an
// unhandled render error in a route — this panel replaces only that pane.
export function RouteErrorBoundary() {
  const error = useRouteError()

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <ErrorState
        heading="This view failed to load"
        message={describeError(error)}
        action={
          <div className="flex items-center gap-4">
            <Button variant="secondary" onClick={() => window.location.reload()}>
              Reload this view
            </Button>
            <Link
              to="/"
              className="text-sm font-medium text-ink-secondary underline-offset-4 hover:text-ink hover:underline"
            >
              Go home
            </Link>
          </div>
        }
      />
    </div>
  )
}
