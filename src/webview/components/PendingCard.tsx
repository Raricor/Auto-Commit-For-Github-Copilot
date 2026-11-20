import { GripVertical } from 'lucide-react';

interface Props {
    label: string;
    fileCount: number;
}

function fileCountLabel(count: number): string {
    return `${count} ${count === 1 ? 'file' : 'files'}`;
}

/** Skeleton shown while the host is still generating this group's message. */
export default function PendingCard({ label, fileCount }: Props) {
    return (
        <div className="commit-card pending-card" aria-busy="true">
            <div className="commit-card-header">
                <div className="commit-card-drag-handle" title="Drag to reorder">
                    <GripVertical size={14} />
                </div>
                <div className="commit-card-body">
                    <div className="slot-card-title">
                        <span className="slot-card-label">{label || 'Generating commit message…'}</span>
                        <span className="slot-card-meta">{fileCountLabel(fileCount)}</span>
                    </div>
                    <div className="skeleton-line" />
                    <div className="skeleton-line skeleton-line-short" />
                </div>
            </div>
        </div>
    );
}
