import { useParams } from 'react-router-dom'
import { Panel } from '../components/ui/Panel'
import { NotFoundPage } from './NotFoundPage'

const POSITIVE_INTEGER = /^[1-9]\d*$/

// Placeholder — replaced wholesale by spec 010. Only validates the route
// param shape (edge case #6); does not fetch, since rendering the actual
// conversation is explicitly out of scope for this spec.
export function ChatPage() {
  const { conversationId } = useParams()

  if (!conversationId || !POSITIVE_INTEGER.test(conversationId)) {
    return <NotFoundPage />
  }

  return (
    <div className="p-6">
      <Panel className="p-8 text-center">
        <p className="text-body text-ink-secondary">
          Chat — conversation #{conversationId}, coming in spec 010.
        </p>
      </Panel>
    </div>
  )
}
