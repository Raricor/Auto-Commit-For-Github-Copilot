import { X } from 'lucide-react';
import type { Notice } from '../state';

interface Props {
    notices: Notice[];
    onDismiss: (id: number) => void;
}

export default function Notices({ notices, onDismiss }: Props) {
    if (notices.length === 0) return null;

    return (
        <div className="notice-list">
            {notices.map((notice) => (
                <div key={notice.id} className={`notice-banner ${notice.level}`} role="status">
                    <span className="notice-message">{notice.message}</span>
                    <button
                        className="notice-close"
                        title="Dismiss"
                        aria-label="Dismiss"
                        onClick={() => onDismiss(notice.id)}
                    >
                        <X size={12} />
                    </button>
                </div>
            ))}
        </div>
    );
}
