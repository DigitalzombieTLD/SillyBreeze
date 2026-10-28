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

export function parseInstructionParagraphs(text, enabled, format = 'angle') {
    if (!enabled) {
        return [{ text: String(text) }];
    }

    const tag = instructionTagSource(format);
    return splitParagraphs(text).map(paragraph => {
        const instructions = [];
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
        return instructions.length ? { text: content, instruction: instructions.join(' ') } : { text: content };
    }).filter(paragraph => paragraph.text);
}

export function extractQuotedAndParenthetical(text, format = 'angle') {
    const output = [];
    const selection = /"(?:\\.|[^"\\])*"|“[^”]*”|«[^»]*»|「[^」]*」|『[^』]*』|\([^()\r\n]+\)/g;
    const leadingTag = new RegExp(`^(${instructionTagSource(format)})(?:[ \\t]*\\r?\\n?|\\s+)?`);

    for (const paragraph of splitParagraphs(text)) {
        const instructionTag = paragraph.match(leadingTag);
        const prefix = instructionTag?.[1] ? `${instructionTag[1]} ` : '';
        const matches = paragraph.slice(instructionTag?.[0].length ?? 0).match(selection);
        if (matches) {
            output.push(`${prefix}${matches.join(' ')}`);
        }
    }

    return output.join('\n\n');
}
