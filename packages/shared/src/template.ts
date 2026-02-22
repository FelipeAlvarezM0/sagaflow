function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== 'object' || current === null || !(part in current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function renderString(input: string, data: Record<string, unknown>): string {
  return input.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, key: string) => {
    const value = resolvePath(data, key);
    if (value === undefined || value === null) {
      return '';
    }
    return String(value);
  });
}

export function renderTemplate<T>(value: T, data: Record<string, unknown>): T {
  if (typeof value === 'string') {
    return renderString(value, data) as T;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => renderTemplate(entry, data)) as T;
  }

  if (typeof value === 'object' && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      output[key] = renderTemplate(val, data);
    }
    return output as T;
  }

  return value;
}
