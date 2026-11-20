// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TapTitles } from './TapTitles';

afterEach(cleanup);

/** A finger tap: down and up in the same place. */
function tap(el: Element, pointerType = 'touch') {
  fireEvent.pointerDown(el, { pointerType, clientX: 50, clientY: 50 });
  fireEvent.pointerUp(el, { pointerType, clientX: 52, clientY: 51 });
}

/** jsdom lays nothing out, so a cut-short name is said by hand. */
function clip(el: Element) {
  Object.defineProperty(el, 'scrollWidth', { value: 300, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: 120, configurable: true });
}

function page() {
  render(
    <div>
      <TapTitles />
      <table>
        <thead>
          <tr>
            <th title="23 Nov 2026 – 29 Nov 2026">w/c 23 Nov</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td title="Dips to -£50,639.34 on 24 Nov 2026">
              <span>▾ £1,200.00</span>
            </td>
            <td title="Click to add to the sum" data-tap-title="off">
              £350.00
            </td>
          </tr>
        </tbody>
      </table>
      <div title="Haulage - International">Haulage - International</div>
      <button type="button" title="Hide Payroll from the forecast">
        eye
      </button>
      <button type="button">
        <span title="MSKU 315 / Ningbo Trading Co">MSKU 315 / Ningbo…</span>
      </button>
      <p>Somewhere else</p>
    </div>,
  );
}

describe('TapTitles (hover titles, for fingers)', () => {
  it('shows a title on a finger tap, and puts it away on the next tap', () => {
    page();
    tap(screen.getByText('w/c 23 Nov'));
    expect(screen.getByRole('tooltip').textContent).toBe('23 Nov 2026 – 29 Nov 2026');
    // The title of what holds the tapped text, however deep the tap landed.
    tap(screen.getByText('▾ £1,200.00'));
    expect(screen.getByRole('tooltip').textContent).toBe('Dips to -£50,639.34 on 24 Nov 2026');
    tap(screen.getByText('Somewhere else'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('a second tap on the same thing closes it; Escape and a scroll do too', () => {
    page();
    const head = screen.getByText('w/c 23 Nov');
    tap(head);
    tap(head);
    expect(screen.queryByRole('tooltip')).toBeNull();
    tap(head);
    expect(screen.getByRole('tooltip')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    tap(head);
    fireEvent.scroll(window);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('leaves a mouse to the browser, and a swipe is not a tap', () => {
    page();
    const head = screen.getByText('w/c 23 Nov');
    tap(head, 'mouse');
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.pointerDown(head, { pointerType: 'touch', clientX: 50, clientY: 50 });
    fireEvent.pointerUp(head, { pointerType: 'touch', clientX: 120, clientY: 50 });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('stays quiet where the title adds nothing to a tap', () => {
    page();
    // A mouse instruction, opted out.
    tap(screen.getByText('£350.00'));
    expect(screen.queryByRole('tooltip')).toBeNull();
    // A control's own title: the tap presses it.
    tap(screen.getByRole('button', { name: 'eye' }));
    expect(screen.queryByRole('tooltip')).toBeNull();
    // A title that repeats text already fully on show.
    tap(screen.getByText('Haulage - International'));
    expect(screen.queryByRole('tooltip')).toBeNull();
    // A name inside a control, not cut short.
    tap(screen.getByText('MSKU 315 / Ningbo…'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows the whole of a name that is cut short, even inside a control', () => {
    page();
    const name = screen.getByText('Haulage - International');
    clip(name);
    tap(name);
    expect(screen.getByRole('tooltip').textContent).toBe('Haulage - International');
    const inButton = screen.getByText('MSKU 315 / Ningbo…');
    clip(inButton);
    tap(inButton);
    expect(screen.getByRole('tooltip').textContent).toBe('MSKU 315 / Ningbo Trading Co');
  });
});
