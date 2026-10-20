export function focusSection(id: string) {
  const node = document.getElementById(id);
  node?.scrollIntoView({ block: "start" });
  node?.focus({ preventScroll: true });
}

export function SectionNav({
  label,
  items,
}: {
  label: string;
  items: readonly (readonly [string, string])[];
}) {
  return (
    <nav className="section-nav" aria-label={label}>
      {items.map(([id, title]) => (
        <a
          key={id}
          href={`#${id}`}
          onClick={(event) => {
            event.preventDefault();
            focusSection(id);
          }}
        >
          {title}
        </a>
      ))}
    </nav>
  );
}
