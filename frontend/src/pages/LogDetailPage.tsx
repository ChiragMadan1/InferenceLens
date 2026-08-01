import { useNavigate, useParams } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { Panel } from '../components/ui/Panel'
import { PageHeader } from '../components/ui/PageHeader'

// Placeholder — FR1's route table requires /logs/:requestId to resolve
// to something; the real detail view is spec 015.
export function LogDetailPage() {
  const navigate = useNavigate()
  const { requestId } = useParams()

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Log detail"
        actions={
          <Button variant="ghost" onClick={() => navigate('/logs')}>
            ← Back to logs
          </Button>
        }
      />
      <Panel className="p-8 text-center">
        <p className="font-data text-body text-ink-secondary">
          Log detail for request {requestId} arrives in spec 015.
        </p>
      </Panel>
    </div>
  )
}
