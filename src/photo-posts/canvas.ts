import headlineUrl from "./assets/SmileySans-Oblique.woff2?url";

const bodyFont = '"PingFang SC", "Microsoft YaHei", sans-serif';
const headlineFont =
  '"Panxu Photo Headline", "PingFang SC", "Microsoft YaHei", sans-serif';
let fontLoading: Promise<void> | undefined;

export function loadPhotoFonts() {
  fontLoading ??= (async () => {
    const face = new FontFace("Panxu Photo Headline", `url(${headlineUrl})`);
    await face.load();
    document.fonts.add(face);
  })().catch(() => {
    fontLoading = undefined;
    throw Error("海报标题字体加载失败，请刷新页面后重试。");
  });
  return fontLoading;
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface TextOptions {
  size: number;
  min?: number;
  weight?: number;
  color: string;
  leading?: number;
  headline?: boolean;
  emphasis?: string;
  highlight?: string;
  highlightLast?: boolean;
  centerY?: boolean;
}

function wrap(ctx: CanvasRenderingContext2D, text: string, width: number) {
  const rows: { text: string; start: number }[] = [];
  let offset = 0;
  for (const paragraph of text.split("\n")) {
    let line = "",
      start = offset;
    // Keep ordinary Latin words intact when they fit on a line.
    const words =
      paragraph.match(/[（(]?[A-Za-z0-9][A-Za-z0-9._+-]*[）)]?|[^]/gu) ?? [];
    for (const word of words) {
      const tokens =
        ctx.measureText(word).width > width ? Array.from(word) : [word];
      for (const token of tokens) {
        if (line && ctx.measureText(line + token).width > width) {
          rows.push({ text: line, start });
          start += line.length;
          line = token;
        } else line += token;
      }
    }
    rows.push({ text: line, start });
    offset += paragraph.length + 1;
  }
  return rows;
}

/** Fit all text or report overflow. Preview clips at the box; export is blocked by the caller. */
export function paintText(
  ctx: CanvasRenderingContext2D,
  text: string,
  box: Box,
  options: TextOptions,
) {
  const leading = options.leading ?? 1.4;
  const minimum = options.min ?? options.size;
  let size = options.size;
  let rows: ReturnType<typeof wrap> = [];
  let fits = false;
  for (; size >= minimum; size -= 2) {
    ctx.font = `${options.headline ? 400 : (options.weight ?? 400)} ${size}px ${options.headline ? headlineFont : bodyFont}`;
    rows = wrap(ctx, text, box.width);
    if (
      rows.length * size * leading <= box.height &&
      rows.every((row) => ctx.measureText(row.text).width <= box.width)
    ) {
      fits = true;
      break;
    }
  }
  if (!fits) {
    size = minimum;
    ctx.font = `${options.headline ? 400 : (options.weight ?? 400)} ${size}px ${options.headline ? headlineFont : bodyFont}`;
    rows = wrap(ctx, text, box.width);
  }
  if (options.headline && !text.includes("\n") && rows.length > 1) {
    const score = (candidate: typeof rows) => {
      const widths = candidate.map((row) => ctx.measureText(row.text).width);
      return Math.max(...widths) - Math.min(...widths);
    };
    let best = score(rows);
    for (
      let targetWidth = box.width - 12;
      targetWidth >= box.width * 0.5;
      targetWidth -= 12
    ) {
      const candidate = wrap(ctx, text, targetWidth);
      if (candidate.length > rows.length) break;
      const value = score(candidate);
      if (value < best) {
        rows = candidate;
        best = value;
      }
    }
  }
  const matches: { start: number; end: number }[] = [];
  if (options.emphasis) {
    let start = text.indexOf(options.emphasis);
    while (start >= 0) {
      matches.push({ start, end: start + options.emphasis.length });
      start = text.indexOf(options.emphasis, start + options.emphasis.length);
    }
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.width, box.height);
  ctx.clip();
  ctx.textBaseline = "top";
  const top =
    box.y +
    (options.centerY
      ? Math.max(0, (box.height - rows.length * size * leading) / 2)
      : 0);
  const write = (value: string, x: number, y: number) => {
    if (options.headline) {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = size * 0.012;
      ctx.lineJoin = "round";
      ctx.strokeText(value, x, y);
    }
    ctx.fillText(value, x, y);
  };
  rows.forEach((row, index) => {
    const y = top + index * size * leading;
    ctx.fillStyle =
      options.highlightLast && !options.emphasis && index === rows.length - 1
        ? (options.highlight ?? options.color)
        : options.color;
    write(row.text, box.x, y);
    for (const match of matches) {
      const start = Math.max(match.start, row.start) - row.start;
      const end = Math.min(match.end, row.start + row.text.length) - row.start;
      if (end <= start) continue;
      ctx.fillStyle = options.highlight ?? options.color;
      write(
        row.text.slice(start, end),
        box.x + ctx.measureText(row.text.slice(0, start)).width,
        y,
      );
    }
  });
  ctx.restore();
  return fits;
}

export function fillBox(
  ctx: CanvasRenderingContext2D,
  box: Box,
  color: string,
) {
  ctx.fillStyle = color;
  ctx.fillRect(box.x, box.y, box.width, box.height);
}

export function arrow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  color: string,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + 56, y);
  ctx.moveTo(x + 38, y - 18);
  ctx.lineTo(x + 56, y);
  ctx.lineTo(x + 38, y + 18);
  ctx.stroke();
}

export function imageContain(
  ctx: CanvasRenderingContext2D,
  image: HTMLImageElement,
  box: Box,
) {
  const scale = Math.min(
    box.width / image.naturalWidth,
    box.height / image.naturalHeight,
  );
  const width = image.naturalWidth * scale,
    height = image.naturalHeight * scale;
  ctx.drawImage(
    image,
    box.x + (box.width - width) / 2,
    box.y + (box.height - height) / 2,
    width,
    height,
  );
}
