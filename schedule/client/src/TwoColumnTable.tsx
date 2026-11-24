import type { CellEditorContext } from "./cells";
import { RowsTable } from "./RowsTable";
import type { BootstrapData, RangeData } from "./types";

/**
 * The two-column table (Issue #46; DESIGN schedule 4.8.1's
 * extension layouts, §7's student table): one month of the rows
 * table stood in two halves side by side — the first half of
 * the month in the left column, the rest in the right — so the
 * month takes the height of half a month, the way the paper
 * student tables have always been laid out (and the way the
 * issued document prints it, publications/render.ts). The two
 * halves are the one RowsTable drawn twice over two slices of
 * the same range: same columns, same cells, same input — each
 * half keeps its own cell activation, as two tables on one
 * screen do. Without an editor (the public screen) both halves
 * are read-only, as in every layout.
 */
export function TwoColumnTable({
  bootstrap,
  range,
  editor,
}: {
  bootstrap: BootstrapData;
  range: RangeData;
  editor?: CellEditorContext;
}) {
  const half = Math.ceil(range.days.length / 2);
  const editorProps = editor ? { editor } : {};
  return (
    <div className="two-column">
      <RowsTable
        bootstrap={bootstrap}
        range={{ ...range, days: range.days.slice(0, half) }}
        {...editorProps}
      />
      <RowsTable
        bootstrap={bootstrap}
        range={{ ...range, days: range.days.slice(half) }}
        {...editorProps}
      />
    </div>
  );
}
