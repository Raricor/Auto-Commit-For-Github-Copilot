import { resolveSetiIcon } from '../fileIcons';
import { useThemeKind } from '../useThemeKind';

interface Props {
    name: string;
}

export default function FileIcon({ name }: Props) {
    const kind = useThemeKind();
    const icon = resolveSetiIcon(name, kind);

    return (
        <span className="seti-icon" style={{ color: icon.color }} aria-hidden="true">
            {icon.character}
        </span>
    );
}
