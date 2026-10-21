import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import TurnStatus, { WaitingNote, fmtDuration, prefillPercent } from '../src/components/TurnStatus.jsx';

describe('TurnStatus', () => {
  it('formats durations and keeps the bar below 100%, slowing down as the estimate is reached', () => {
    expect(fmtDuration(83_000)).toBe('1:23');
    expect(prefillPercent(0, 10_000)).toBe(0);
    expect(prefillPercent(5_000, 10_000)).toBeGreaterThan(50);
    expect(prefillPercent(500_000, 10_000)).toBeLessThanOrEqual(95);
  });
  it('shows the token count and time left when an estimate exists', () => {
    render(<TurnStatus phase={{ name: 'prefill', since: Date.now(), tokens: 12000, etaMs: 40_000 }} />);
    expect(screen.getByText(/Processing prompt \(~12k tokens\) - this may take some time/)).toBeInTheDocument();
    expect(screen.getByTestId('turn-elapsed')).toHaveTextContent(/about 0:\d\d left/);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow');
  });
  it('is indeterminate without an estimate, and admits when it overruns one', () => {
    const { rerender } = render(<TurnStatus phase={{ name: 'prefill', since: Date.now(), tokens: 900, etaMs: null }} />);
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow');
    rerender(<TurnStatus phase={{ name: 'prefill', since: Date.now() - 60_000, tokens: 900, etaMs: 5_000 }} />);
    expect(screen.getByTestId('turn-elapsed')).toHaveTextContent('taking longer than estimated');
  });
});
