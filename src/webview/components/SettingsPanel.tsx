import { ChevronDown, ChevronRight, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GenerateOptions, ReasoningEffort } from '../../types';

interface Props {
    settings: GenerateOptions;
    models: Array<{ id: string; name: string }>;
    prompt: string;
    onUpdate: (key: string, value: unknown) => void;
    onPromptChange: (prompt: string) => void;
}

type CommitCountKey = 'minCommits' | 'maxCommits';

const MAX_COMMITS = 200;

const EFFORT_OPTIONS: Array<{ value: ReasoningEffort | ''; label: string }> = [
    { value: '', label: 'Model default' },
    { value: 'none', label: 'None' },
    { value: 'low', label: 'Low' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'High' },
    { value: 'xhigh', label: 'Extra high' },
    { value: 'max', label: 'Max' },
];

function toCountText(value: number | undefined): string {
    return value && value > 0 ? String(value) : '';
}

function toCount(text: string): number {
    if (text === '') return 0;
    const parsed = Number.parseInt(text, 10);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.min(MAX_COMMITS, parsed));
}

function normalizeCountInput(raw: string): string {
    const digits = raw.replace(/[^\d]/g, '');
    if (digits === '') return '';
    const value = Math.min(MAX_COMMITS, Number.parseInt(digits, 10));
    return value === 0 ? '' : String(value);
}

export default function SettingsPanel({ settings, models, prompt, onUpdate, onPromptChange }: Props) {
    const [expanded, setExpanded] = useState(true);
    const [minText, setMinText] = useState(toCountText(settings.minCommits));
    const [maxText, setMaxText] = useState(toCountText(settings.maxCommits));
    const [rangeError, setRangeError] = useState(false);

    useEffect(() => {
        setMinText(toCountText(settings.minCommits));
    }, [settings.minCommits]);

    useEffect(() => {
        setMaxText(toCountText(settings.maxCommits));
    }, [settings.maxCommits]);

    const handleCountChange = (key: CommitCountKey, raw: string) => {
        const text = normalizeCountInput(raw);
        if (key === 'minCommits') setMinText(text);
        else setMaxText(text);

        const nextMin = key === 'minCommits' ? toCount(text) : toCount(minText);
        const nextMax = key === 'maxCommits' ? toCount(text) : toCount(maxText);
        const invalid = nextMin > 0 && nextMax > 0 && nextMin > nextMax;
        setRangeError(invalid);
        if (invalid) return;

        // Send both so a value that was previously blocked by validation is synced too.
        if (nextMin !== (settings.minCommits ?? 0)) onUpdate('minCommits', nextMin);
        if (nextMax !== (settings.maxCommits ?? 0)) onUpdate('maxCommits', nextMax);
    };

    return (
        <div className="panel-card">
            <button className="panel-toggle" onClick={() => setExpanded(!expanded)}>
                <div className="panel-toggle-left">
                    <Settings size={16} />
                    <span>Configuration</span>
                </div>
                <div className="panel-toggle-right">
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </div>
            </button>

            {expanded && (
                <div className="panel-body">
                    <div className="config-grid">
                        <div className="config-field">
                            <span className="config-label">Model</span>
                            <select
                                className="config-select"
                                value={settings.model || ''}
                                onChange={(e) => onUpdate('model', e.target.value)}
                            >
                                <option value="">Auto (gpt-4o)</option>
                                {models.map((m) => (
                                    <option key={m.id} value={m.id}>{m.name || m.id}</option>
                                ))}
                            </select>
                        </div>
                        <div className="config-field">
                            <span className="config-label">Language</span>
                            <select
                                className="config-select"
                                value={settings.language}
                                onChange={(e) => onUpdate('language', e.target.value)}
                            >
                                <option value="en">English</option>
                                <option value="zh">中文</option>
                                <option value="auto">Auto</option>
                            </select>
                        </div>
                    </div>

                    <div className="config-grid">
                        <div className="config-field">
                            <span className="config-label">Min commits</span>
                            <input
                                type="number"
                                className="config-input"
                                min={0}
                                max={MAX_COMMITS}
                                step={1}
                                value={minText}
                                placeholder="No limit"
                                onChange={(e) => handleCountChange('minCommits', e.target.value)}
                            />
                        </div>
                        <div className="config-field">
                            <span className="config-label">Max commits</span>
                            <input
                                type="number"
                                className="config-input"
                                min={0}
                                max={MAX_COMMITS}
                                step={1}
                                value={maxText}
                                placeholder="No limit"
                                onChange={(e) => handleCountChange('maxCommits', e.target.value)}
                            />
                        </div>
                    </div>

                    {rangeError && (
                        <div className="config-error-text" role="alert">Min cannot exceed Max</div>
                    )}

                    <div className="config-field config-field-wide">
                        <span className="config-label">Thinking effort</span>
                        <select
                            className="config-select"
                            value={settings.reasoningEffort ?? ''}
                            onChange={(e) => onUpdate('reasoningEffort', e.target.value)}
                        >
                            {EFFORT_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                        </select>
                        <span className="config-hint">
                            Applies to every request. Models ignore levels they do not support.
                        </span>
                    </div>

                    <label className="config-checkbox-row">
                        <input
                            type="checkbox"
                            checked={settings.conventionalCommits}
                            onChange={(e) => onUpdate('conventionalCommits', e.target.checked)}
                        />
                        Use Conventional Commits format
                    </label>

                    <div className="config-textarea-wrap">
                        <span className="config-label">Custom Prompt</span>
                        <textarea
                            className="config-textarea"
                            value={prompt}
                            onChange={(e) => onPromptChange(e.target.value)}
                            placeholder="Enter additional prompt instructions..."
                            rows={3}
                        />
                    </div>
                </div>
            )}
        </div>
    );
}
