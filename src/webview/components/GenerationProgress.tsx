import type { GenerationProgress as Progress } from '../../types';

interface Props {
    progress: Progress | null;
}

function clampPercent(done: number, total: number): number {
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, (done / total) * 100));
}

export default function GenerationProgress({ progress }: Props) {
    const stage = progress?.stage ?? 'grouping';
    const detail = progress?.detail;
    const done = progress?.done ?? 0;
    const total = progress?.total ?? 0;

    let label: string;
    if (stage === 'generating') {
        label = `Generating commit messages · ${done} / ${total}`;
    } else if (stage === 'ordering') {
        label = 'Ordering commits…';
    } else {
        label = 'Grouping changes…';
    }

    return (
        <div className="progress-wrap" role="status" aria-live="polite">
            <div className="progress-row">
                <span className="spinner spinner-sm" />
                <span className="progress-label">{label}</span>
            </div>
            {detail && <div className="progress-detail">{detail}</div>}
            {stage === 'generating' && (
                <div
                    className="progress-bar"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={total || 0}
                    aria-valuenow={done}
                >
                    <div className="progress-bar-fill" style={{ width: `${clampPercent(done, total)}%` }} />
                </div>
            )}
        </div>
    );
}
