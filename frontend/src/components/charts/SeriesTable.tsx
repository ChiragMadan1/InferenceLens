import type { ReactNode } from 'react'
import { ScrollArea } from '../ui/ScrollArea'

export type SeriesTableColumn = {
  key: string
  label: string
  numeric?: boolean
}

type SeriesTableProps = {
  caption: string
  columns: SeriesTableColumn[]
  rows: Array<Record<string, ReactNode>>
}

// FR25 — every chart panel's non-visual channel: the same series rendered
// as an accessible HTML table with a caption. Required, not optional.
export function SeriesTable({ caption, columns, rows }: SeriesTableProps) {
  return (
    <ScrollArea className="h-full">
      <table className="w-full border-collapse">
        <caption className="px-1 pb-2 text-left text-sm text-ink-secondary">{caption}</caption>
        <thead>
          <tr className="border-b border-hairline">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={[
                  'py-2 pr-4 text-micro font-medium uppercase text-ink-muted',
                  col.numeric ? 'text-right' : 'text-left',
                ].join(' ')}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="py-4 text-center text-sm text-ink-muted">
                No data in this window.
              </td>
            </tr>
          )}
          {rows.map((row, index) => (
            <tr key={index} className="border-b border-hairline last:border-0">
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={[
                    'py-1.5 pr-4 text-sm',
                    col.numeric ? 'font-data tabular-nums text-right text-ink' : 'text-ink-secondary',
                  ].join(' ')}
                >
                  {row[col.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollArea>
  )
}
