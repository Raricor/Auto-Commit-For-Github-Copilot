import { Check, ChevronDown, ChevronRight, Edit2, FileCode, GitCommit, GripVertical, Info, X } from 'lucide-react';
import { useState } from 'react';
import type { CommitCandidate } from '../../types';

interface Props {
    candidate: CommitCandidate;
    index: number;
    onToggle: () => void;
    onCommitOne: () => void;
    commitDisabled: boolean;
    onOpenFile: (path: string) => void;
    onUpdateMessage: (message: string) => void;
    onDragStart: (index: number) => void;
    onDragOver: (e: React.DragEvent, index: number) => void;
    onDrop: () => void;
}

export default function CommitCard({
    candidate, index, onToggle, onCommitOne, commitDisabled, onOpenFile, onUpdateMessage,
    onDragStart, onDragOver, onDrop,
}: Props) {
    const [expanded, setExpanded] = useState(true);
    const [editing, setEditing] = useState(false);
    const [editText, setEditText] = useState(candidate.message);
    const [isDragOver, setIsDragOver] = useState(false);

    const handleSave = () => {
        if (editText.trim()) {
            onUpdateMessage(editText.trim());
            setEditing(false);
        }
    };

    const handleCancel = () => {
        setEditText(candidate.message);
        setEditing(false);
    };

    return (
        <div
            className={`commit-card${candidate.checked ? ' selected' : ''}${isDragOver ? ' drag-over' : ''}`}
            draggable
            onDragStart={() => onDragStart(index)}
            onDragOver={(e) => { onDragOver(e, index); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={() => { onDrop(); setIsDragOver(false); }}
            onDragEnd={() => setIsDragOver(false)}
        >
            <div className="commit-card-header" onClick={() => !editing && setExpanded(!expanded)}>
                <div className="commit-card-drag-handle" title="Drag to reorder">
                    <GripVertical size={14} />
                </div>
                <input
                    type="checkbox"
                    className="commit-card-checkbox"
                    checked={candidate.checked}
                    onClick={(e) => e.stopPropagation()}
                    onChange={onToggle}
                />
                <GitCommit size={16} className="commit-card-icon" />
                <div className="commit-card-body">
                    {editing ? (
                        <div className="commit-card-edit" onClick={(e) => e.stopPropagation()}>
                            <textarea
                                className="commit-card-edit-input"
                                value={editText}
                                onChange={(e) => setEditText(e.target.value)}
                                rows={2}
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSave(); }
                                    if (e.key === 'Escape') handleCancel();
                                }}
                            />
                            <div className="commit-card-edit-actions">
                                <button className="edit-btn save" onClick={handleSave}>
                                    <Check size={12} /> Save
                                </button>
                                <button className="edit-btn cancel" onClick={handleCancel}>
                                    <X size={12} /> Cancel
                                </button>
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="commit-card-message">{candidate.message}</div>
                            {candidate.reason && (
                                <div className="commit-card-reason">
                                    <Info size={14} />
                                    <span>{candidate.reason}</span>
                                </div>
                            )}
                            {expanded && candidate.files.length > 0 && (
                                <div className="commit-card-files">
                                    {candidate.files.map((f) => (
                                        <div key={f} className="commit-card-file">
                                            <FileCode size={12} />
                                            <span onClick={(e) => { e.stopPropagation(); onOpenFile(f); }}>{f}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </>
                    )}
                </div>
                {!editing && (
                    <div className="commit-card-actions">
                        <button
                            className="commit-card-action-btn"
                            title="Commit this"
                            disabled={commitDisabled}
                            onClick={(e) => {
                                e.stopPropagation();
                                onCommitOne();
                            }}
                        >
                            <Check size={13} />
                        </button>
                        <button
                            className="commit-card-action-btn"
                            title="Edit message"
                            onClick={(e) => {
                                e.stopPropagation();
                                setEditText(candidate.message);
                                setEditing(true);
                            }}
                        >
                            <Edit2 size={13} />
                        </button>
                        <span className={`commit-card-chevron${expanded ? ' expanded' : ''}`}>
                            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
}
