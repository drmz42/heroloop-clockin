import { Component, type ReactNode } from 'react';

interface CombatErrorBoundaryProps {
  children: ReactNode;
  resetKey: string;
  onRetry?: () => void;
}

interface CombatErrorBoundaryState {
  failed: boolean;
}

export class CombatErrorBoundary extends Component<CombatErrorBoundaryProps, CombatErrorBoundaryState> {
  state: CombatErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): CombatErrorBoundaryState {
    return { failed: true };
  }

  componentDidUpdate(previous: CombatErrorBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  private retry = () => {
    this.setState({ failed: false });
    this.props.onRetry?.();
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="absolute inset-0 z-40 grid place-items-center bg-[#0b0d0b]/90 p-6" role="alert" data-combat-error-boundary>
        <div className="max-w-sm rounded-lg border border-amber-500/50 bg-[#17130d] p-4 text-center shadow-2xl">
          <strong className="font-pixel text-sm text-amber-200">BATTLE DISPLAY RECOVERING</strong>
          <p className="mt-2 font-vt text-sm text-[#cfc5b4]">Your progress is safe on the server. Restart only this battle view.</p>
          <button type="button" className="game-control game-primary mt-3" onClick={this.retry}>RESTART BATTLE VIEW</button>
        </div>
      </div>
    );
  }
}
