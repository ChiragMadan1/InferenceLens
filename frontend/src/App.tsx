import { useEffect, useState } from 'react'
import { checkHealth } from './api'

function App() {
  const [status, setStatus] = useState<string>('checking...')

  useEffect(() => {
    checkHealth()
      .then((data) => setStatus(data.status))
      .catch(() => setStatus('backend not reachable'))
  }, [])

  return (
    <div style={{ padding: 24, fontFamily: 'sans-serif' }}>
      <h1>App</h1>
      <p>Backend status: {status}</p>
      {/* Feature UI goes here, built incrementally */}
    </div>
  )
}

export default App
