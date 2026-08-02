import { useState } from 'react'
import { Button } from '../ui/Button'

type Message = { role: string; content: unknown }

// Edge case #20 — a non-string content block (a future multi-part message)
// renders as formatted JSON rather than throwing or printing [object Object].
function EntryContent({ content }: { content: unknown }) {
  if (typeof content === 'string') {
    return <div className="whitespace-pre-wrap text-sm text-ink [overflow-wrap:anywhere]">{content}</div>
  }
  return (
    <pre className="max-h-64 overflow-auto rounded-md bg-surface-sunken p-2 font-data text-sm text-ink">
      {JSON.stringify(content, null, 2)}
    </pre>
  )
}

function MessageBlock({ message, collapsedByDefault }: { message: Message; collapsedByDefault: boolean }) {
  const [collapsed, setCollapsed] = useState(collapsedByDefault)
  return (
    <div
      className={[
        'flex flex-col gap-1.5 rounded-md border border-hairline p-3',
        collapsedByDefault ? 'bg-surface-sunken' : 'bg-surface',
      ].join(' ')}
    >
      <div className="flex items-center justify-between">
        <span className="text-micro uppercase text-ink-muted">{message.role}</span>
        {collapsedByDefault && (
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            className="text-sm text-ink-secondary underline-offset-2 hover:text-ink hover:underline"
          >
            {collapsed ? 'Show' : 'Hide'}
          </button>
        )}
      </div>
      {!collapsed && <EntryContent content={message.content} />}
    </div>
  )
}

function useCopyStatus(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false)
  const copy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(false))
      .finally(() => setTimeout(() => setCopied(false), 1500))
  }
  return [copied, copy]
}

type PromptTranscriptProps = { messages: Message[] }

// FR38 — one block per entry, role-labelled in micro type, system prompt
// visually distinguished and collapsed by default (identical on every log,
// it would otherwise dominate the page). Plain text only — never HTML,
// never dangerouslySetInnerHTML.
export function PromptTranscript({ messages }: PromptTranscriptProps) {
  const [copied, copy] = useCopyStatus()

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-h2 font-display text-ink">Prompt</h3>
        <Button variant="ghost" size="sm" onClick={() => copy(JSON.stringify(messages, null, 2))}>
          {copied ? 'Copied' : 'Copy full prompt'}
        </Button>
      </div>
      {messages.length === 0 ? (
        <p className="text-sm text-ink-muted">No messages recorded.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {messages.map((message, index) => (
            <MessageBlock key={index} message={message} collapsedByDefault={message.role === 'system'} />
          ))}
        </div>
      )}
    </div>
  )
}
