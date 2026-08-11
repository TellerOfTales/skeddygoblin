/**
 * /availability is guild-scoped by construction - every write is keyed to a
 * group_id - so a DM has to resolve which server before anything can happen.
 */

import { describe, expect, it } from 'vitest';
import { assertLegalMessage } from '../../src/discord/componentLimits.js';
import { serverPickerView } from '../../src/discord/views/serverPicker.view.js';
import { parseCustomId } from '../../src/discord/customId.js';

interface RawButton {
  label?: string;
  custom_id?: string;
}

function buttons(view: { components?: readonly unknown[] | undefined }): RawButton[] {
  return (view.components ?? []).flatMap(
    (row) => (row as { toJSON(): { components: RawButton[] } }).toJSON().components,
  );
}

const many = Array.from({ length: 12 }, (_, index) => ({
  id: index + 1,
  name: `Server ${index + 1}`,
}));

describe('serverPickerView', () => {
  it('stays legal with a lot of servers', () => {
    assertLegalMessage(serverPickerView({ groups: many, hasDefaults: true }), 'serverPicker');
  });

  it('gives every server a one-tap button carrying its id', () => {
    const view = serverPickerView({
      groups: [
        { id: 7, name: 'The Basement' },
        { id: 9, name: 'Raid Night' },
      ],
      hasDefaults: false,
    });

    const labels = buttons(view).map((button) => button.label);
    expect(labels).toEqual(['The Basement', 'Raid Night']);

    const parsed = parseCustomId(buttons(view)[0]!.custom_id!);
    expect(parsed.action).toBe('pick');
    expect(parsed.namespace).toBe('av');
  });

  it('offers apply-everywhere only when there is a template to apply', () => {
    const without = buttons(serverPickerView({ groups: many.slice(0, 2), hasDefaults: false }));
    expect(without.map((button) => button.label)).not.toContain('Apply my defaults everywhere');

    const with_ = buttons(serverPickerView({ groups: many.slice(0, 2), hasDefaults: true }));
    expect(with_.map((button) => button.label)).toContain('Apply my defaults everywhere');
  });

  it('says so rather than silently dropping servers past the limit', () => {
    const view = serverPickerView({
      groups: Array.from({ length: 26 }, (_, index) => ({ id: index + 1, name: `S${index + 1}` })),
      hasDefaults: false,
    });
    expect(view.content).toMatch(/Showing 20 of 26/);
  });
});
