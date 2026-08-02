import { lazy, Suspense, type ReactNode } from 'react'
import { createBrowserRouter } from 'react-router-dom'
import { AppShell } from './App'
import { RouteErrorBoundary } from './components/shell/RouteErrorBoundary'
import { Skeleton } from './components/ui/Skeleton'

// FR7 — every leaf route is code-split so the logs dashboard's chart
// bundle (spec 015) never lands in the initial payload.
const NewChatPage = lazy(() =>
  import('./pages/NewChatPage').then((m) => ({ default: m.NewChatPage })),
)
const ChatPage = lazy(() =>
  import('./pages/ChatPage').then((m) => ({ default: m.ChatPage })),
)
const LogsDashboardPage = lazy(() =>
  import('./pages/LogsDashboardPage').then((m) => ({ default: m.LogsDashboardPage })),
)
const LogDetailPage = lazy(() =>
  import('./pages/LogDetailPage').then((m) => ({ default: m.LogDetailPage })),
)
const NotFoundPage = lazy(() =>
  import('./pages/NotFoundPage').then((m) => ({ default: m.NotFoundPage })),
)

function RouteSkeleton() {
  return (
    <div className="flex flex-1 flex-col gap-4 p-6">
      <Skeleton variant="text" className="w-48" />
      <Skeleton variant="block" style={{ height: '12rem' }} />
    </div>
  )
}

function RouteSuspense({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteSkeleton />}>{children}</Suspense>
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteErrorBoundary />,
    children: [
      {
        index: true,
        element: (
          <RouteSuspense>
            <NewChatPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'c/:conversationId',
        element: (
          <RouteSuspense>
            <ChatPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'logs',
        element: (
          <RouteSuspense>
            <LogsDashboardPage />
          </RouteSuspense>
        ),
      },
      {
        path: 'logs/:requestId',
        element: (
          <RouteSuspense>
            <LogDetailPage />
          </RouteSuspense>
        ),
      },
      {
        path: '*',
        element: (
          <RouteSuspense>
            <NotFoundPage />
          </RouteSuspense>
        ),
      },
    ],
  },
])
