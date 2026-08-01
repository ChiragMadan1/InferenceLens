import { useNavigate } from 'react-router-dom'
import { Button } from '../components/ui/Button'
import { Panel } from '../components/ui/Panel'
import { PageHeader } from '../components/ui/PageHeader'

// Placeholder — the real dashboard (charts, KPI tiles) is spec 015.
// AppShell already hides the rail on /logs*; this page supplies the
// "Back to chat" control called for in FR3 and the acceptance criteria.
export function LogsDashboardPage() {
  const navigate = useNavigate()

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        title="Inference logs"
        actions={
          <Button variant="ghost" onClick={() => navigate('/')}>
            ← Back to chat
          </Button>
        }
      />
      <Panel className="p-8 text-center">
        <p className="text-body text-ink-secondary">The logs dashboard arrives in spec 015.</p>
      </Panel>
    </div>
  )
}
