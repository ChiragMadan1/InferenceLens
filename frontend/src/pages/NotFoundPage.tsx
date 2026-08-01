import { useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { ErrorState } from '../components/ui/ErrorState'

// Reusable "what's missing + two navigations out" panel — both the `*`
// route and ChatPage's invalid-id case (edge case #6) render this.
export function NotFoundPage() {
  const navigate = useNavigate()

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <ErrorState
        heading="This page doesn't exist"
        message="The page you're looking for isn't here."
        action={
          <div className="flex items-center gap-4">
            <Button variant="secondary" onClick={() => navigate('/')}>
              Back to conversations
            </Button>
            <button
              type="button"
              onClick={() => navigate(-1)}
              className="text-sm font-medium text-ink-secondary underline-offset-4 hover:text-ink hover:underline"
            >
              Go back
            </button>
          </div>
        }
      />
    </div>
  )
}
