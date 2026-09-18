import { Fragment } from 'react';
import type { Field } from '@docreview/shared';
import { GROUPS, GROUP_LABEL } from '@docreview/shared';
import { FieldRow, type RowProps } from './FieldRow';
import type { Editing } from './reducer';

type Props = {
  fields: Field[];
  cursorKey: string | null;
  editing: Editing | null;
  conflict: { fieldKey: string; theirs: Field } | null;
  handlers: (f: Field) => Omit<RowProps, 'field' | 'selected' | 'editing' | 'conflict'>;
};

export function FieldList({ fields, cursorKey, editing, conflict, handlers }: Props) {
  if (fields.length === 0) {
    return (
      <div className="list-empty">
        <p><b>Nothing matches this filter.</b></p>
        <p>Either everything here has been reviewed, or the filter is narrower than the document.</p>
      </div>
    );
  }

  return (
    <ul className="field-list" role="listbox" aria-label="Extracted fields">
      {GROUPS.map((g) => {
        const rows = fields.filter((f) => f.group === g);
        if (rows.length === 0) return null;
        return (
          <Fragment key={g}>
            <li className="group-head" role="presentation">{GROUP_LABEL[g]}</li>
            {rows.map((f) => (
              <FieldRow
                key={f.key}
                field={f}
                selected={cursorKey === f.key}
                editing={editing?.key === f.key ? editing : null}
                conflict={conflict?.fieldKey === f.key ? conflict.theirs : null}
                {...handlers(f)}
              />
            ))}
          </Fragment>
        );
      })}
    </ul>
  );
}
