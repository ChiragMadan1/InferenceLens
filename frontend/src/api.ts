const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'

export async function checkHealth() {
  const res = await fetch(`${BASE_URL}/health`)
  if (!res.ok) throw new Error('health check failed')
  return res.json()
}

// Add one function per endpoint as features are built, e.g.:
//
// export async function createItem(name: string, createdBy: number) {
//   const res = await fetch(`${BASE_URL}/items`, {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json' },
//     body: JSON.stringify({ name, created_by: createdBy }),
//   })
//   if (!res.ok) throw new Error('failed to create item')
//   return res.json()
// }
