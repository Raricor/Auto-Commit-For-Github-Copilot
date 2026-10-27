import { useCallback, useRef } from 'react';
import type { CommitCandidate } from '../../types';
import CommitCard from './CommitCard';

interface Props {
    candidates: CommitCandidate[];
    onToggle: (id: string) => void;
    onOpenFile: (path: string) => void;
    onReorder: (candidates: CommitCandidate[]) => void;
    onUpdateMessage: (id: string, message: string) => void;
    onCommitOne: (id: string) => void;
    commitDisabled: boolean;
}

export default function CandidatesList({
    candidates, onToggle, onOpenFile, onReorder, onUpdateMessage, onCommitOne, commitDisabled,
}: Props) {
    const dragIndex = useRef<number | null>(null);
    const dragOverIndex = useRef<number | null>(null);

    // Display reversed so newest generated candidate appears at the top (stack feel).
    // Execution order is bottom → top (oldest/first generated commits first).
    const reversed = [...candidates].reverse();

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
        const reordered = [...candidates].reverse();
        const [removed] = reordered.splice(dragIndex.current, 1);
        reordered.splice(dragOverIndex.current, 0, removed);
        onReorder(reordered.reverse());

        dragIndex.current = null;
        dragOverIndex.current = null;
    }, [candidates, onReorder]);

    return (
        <div className="commit-list">
            <div className="commit-list-hint commit-list-hint-top">
                ↑ commits last
            </div>
            {reversed.map((c, i) => (
                <CommitCard
                    key={c.id}
                    index={i}
                    candidate={c}
                    onToggle={() => onToggle(c.id)}
                    onOpenFile={onOpenFile}
                    onUpdateMessage={(msg) => onUpdateMessage(c.id, msg)}
                    onCommitOne={() => onCommitOne(c.id)}
                    commitDisabled={commitDisabled}
                    onDragStart={handleDragStart}
                    onDragOver={handleDragOver}
                    onDrop={handleDrop}
                />
            ))}
            <div className="commit-list-hint">
                ↓ commits first  ·  ↕ drag to reorder
            </div>
        </div>
    );
}
