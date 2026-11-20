import { useCallback, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { slotKey } from '../state';
import type { Slot } from '../state';
import CommitCard from './CommitCard';
import FailedCard from './FailedCard';
import PendingCard from './PendingCard';

interface Props {
    slots: Slot[];
    moves: Record<string, number>;
    showAiReorder: boolean;
    onUndoReorder: () => void;
    onToggle: (id: string) => void;
    onOpenFile: (path: string) => void;
    onReorder: (slots: Slot[]) => void;
    onUpdateMessage: (id: string, message: string) => void;
    onCommitOne: (id: string) => void;
    onRetryGroup: (groupIndex: number) => void;
    commitDisabled: boolean;
    listRef: RefObject<HTMLDivElement | null>;
}

export default function CandidatesList({
    slots, moves, showAiReorder, onUndoReorder, onToggle, onOpenFile, onReorder,
    onUpdateMessage, onCommitOne, onRetryGroup, commitDisabled, listRef,
}: Props) {
    const dragIndex = useRef<number | null>(null);
    const dragOverIndex = useRef<number | null>(null);
    const [dragOver, setDragOver] = useState<number | null>(null);

    // Display reversed so the last commit appears at the top (stack feel).
    // Execution order is bottom → top (first commit first).
    const reversed = [...slots].reverse();

    const handleDragStart = useCallback((index: number) => {
        dragIndex.current = index;
    }, []);

    const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
        e.preventDefault();
        dragOverIndex.current = index;
    }, []);

    const handleDrop = useCallback(() => {
        if (dragIndex.current === null || dragOverIndex.current === null) return;
        if (dragIndex.current === dragOverIndex.current) return;

        // Drag indices are in reversed-display space; reorder there then un-reverse.
        const reordered = [...slots].reverse();
        const [removed] = reordered.splice(dragIndex.current, 1);
        reordered.splice(dragOverIndex.current, 0, removed);
        onReorder(reordered.reverse());

        dragIndex.current = null;
        dragOverIndex.current = null;
    }, [slots, onReorder]);

    const handleDragEnd = useCallback(() => {
        dragIndex.current = null;
        dragOverIndex.current = null;
        setDragOver(null);
    }, []);

    return (
        <div className="commit-list" ref={listRef}>
            {showAiReorder && (
                <div className="reorder-banner">
                    <span>Reordered by AI to respect dependencies</span>
                    <span className="reorder-banner-sep">·</span>
                    <button className="reorder-undo" onClick={onUndoReorder}>Undo</button>
                </div>
            )}
            <div className="commit-list-hint commit-list-hint-top">
                ↑ commits last
            </div>
            {reversed.map((slot, index) => {
                const key = slotKey(slot);
                const candidate = slot.candidate;
                return (
                    <div
                        key={key}
                        data-flip-key={key}
                        className={`commit-slot${dragOver === index ? ' drag-over' : ''}`}
                        draggable
                        onDragStart={() => handleDragStart(index)}
                        onDragOver={(e) => {
                            handleDragOver(e, index);
                            setDragOver(index);
                        }}
                        onDragLeave={() => setDragOver((current) => current === index ? null : current)}
                        onDrop={() => {
                            handleDrop();
                            setDragOver(null);
                        }}
                        onDragEnd={handleDragEnd}
                    >
                        {slot.status === 'ready' && candidate ? (
                            <CommitCard
                                index={index}
                                candidate={candidate}
                                move={moves[candidate.id]}
                                onToggle={() => onToggle(candidate.id)}
                                onOpenFile={onOpenFile}
                                onUpdateMessage={(message) => onUpdateMessage(candidate.id, message)}
                                onCommitOne={() => onCommitOne(candidate.id)}
                                commitDisabled={commitDisabled}
                            />
                        ) : slot.status === 'failed' || slot.status === 'retrying' ? (
                            <FailedCard
                                label={slot.label}
                                fileCount={slot.files.length}
                                error={slot.error || 'Unknown error'}
                                retrying={slot.status === 'retrying'}
                                onRetry={() => onRetryGroup(slot.groupIndex)}
                            />
                        ) : (
                            <PendingCard label={slot.label} fileCount={slot.files.length} />
                        )}
                    </div>
                );
            })}
            <div className="commit-list-hint">
                ↓ commits first  ·  ↕ drag to reorder
            </div>
        </div>
    );
}
