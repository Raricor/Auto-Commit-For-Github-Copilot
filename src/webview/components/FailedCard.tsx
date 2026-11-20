import { AlertTriangle, ChevronDown, ChevronRight, GripVertical, RotateCw } from 'lucide-react';
import { useState } from 'react';

interface Props {
    label: string;
    fileCount: number;
    error: string;
    retrying: boolean;
    onRetry: () => void;
}

function fileCountLabel(count: number): string {
    return `${count} ${count === 1 ? 'file' : 'files'}`;
}

export default function FailedCard({ label, fileCount, error, retrying, onRetry }: Props) {
    const [expanded, setExpanded] = useState(false);

    return (
        <div className={`commit-card failed-card${retrying ? ' retrying' : ''}`}>
            <div className="commit-card-header">
                <div className="commit-card-drag-handle" title="Drag to reorder">
                    <GripVertical size={14} />
                </div>
                <AlertTriangle size={16} className="failed-card-icon" />
                <div className="commit-card-body">
                    <div className="slot-card-title">
                        <span className="slot-card-label">{label || 'Commit generation failed'}</span>
                        <span className="slot-card-meta">{fileCountLabel(fileCount)}</span>
                    </div>
                    {!retrying && error && (
                        <button
                            className={`failed-card-error${expanded ? ' expanded' : ''}`}
                            title={expanded ? 'Hide full error' : 'Show full error'}
                            onClick={(e) => {
                                e.stopPropagation();
                                setExpanded(!expanded);
                            }}
                        >
                            <span className="failed-card-error-text">{error}</span>
                            <span className="failed-card-error-chevron">
                                {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                            </span>
                        </button>
                    )}
                </div>
                <button
                    className="retry-btn"
                    disabled={retrying}
                    onClick={(e) => {
                        e.stopPropagation();
                        onRetry();
                    }}
                >
                    {retrying ? <span className="spinner spinner-xs" /> : <RotateCw size={12} />}
                    {retrying ? 'Retrying…' : 'Retry'}
                </button>
            </div>
        </div>
    );
}
