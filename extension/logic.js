export function splitParagraphs(text) {
    return String(text)
        .replace(/\r\n?/g, '\n')
        .split(/\n[ \t]*\n+/)
        .map(paragraph => paragraph.trim())
        .filter(Boolean);
}

export const INSTRUCTION_FORMATS = {
    angle: ['<', '>'],
    square: ['\\[', '\\]'],
    round: ['\\(', '\\)'],
};

function instructionTagSource(format) {
    const [open, close] = INSTRUCTION_FORMATS[format] ?? INSTRUCTION_FORMATS.angle;
    // Both "instruction" and "instructions" are accepted.
    return `${open}instructions?="([^"]*)"${close}`;
}

export function parseInstructionParagraphs(text, enabled, format = 'angle', mergeInstructionBlankLine = false) {
    if (!enabled) {
        return [{ text: String(text) }];
    }

    const tag = instructionTagSource(format);
    let pending = [];
    return splitParagraphs(text).map(paragraph => {
        const instructions = [...pending];
        pending = [];
        const content = paragraph
            .replace(new RegExp(tag, 'g'), (_match, value) => {
                const trimmed = value.trim();
                if (trimmed) {
                    instructions.push(trimmed);
                }
                return ' ';
            })
            .replace(/[ \t]{2,}/g, ' ')
            .trim();
        if (mergeInstructionBlankLine && !content && instructions.length) {
            // An instruction-only paragraph applies to the next paragraph.
            pending = instructions;
            return { text: '' };
        }
        return instructions.length ? { text: content, instruction: instructions.join(' ') } : { text: content };
    }).filter(paragraph => paragraph.text);
}

export function extractQuotedAndParenthetical(text, format = 'angle', mergeInstructionBlankLine = false) {
    const output = [];
    const selection = /"(?:\\.|[^"\\])*"|“[^”]*”|«[^»]*»|「[^」]*」|『[^』]*』|\([^()\r\n]+\)/g;
    const leadingTag = new RegExp(`^(${instructionTagSource(format)})(?:[ \\t]*\\r?\\n?|\\s+)?`);

    for (const paragraph of splitParagraphs(text)) {
        const instructionTag = paragraph.match(leadingTag);
        const prefix = instructionTag?.[1] ? `${instructionTag[1]} ` : '';
        const rest = paragraph.slice(instructionTag?.[0].length ?? 0);
        const matches = rest.match(selection);
        if (mergeInstructionBlankLine && prefix && !rest.trim()) {
            output.push(prefix.trim());
        } else if (matches) {
            output.push(`${prefix}${matches.join(' ')}`);
        }
    }

    return output.join('\n\n');
}
