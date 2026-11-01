// Casamento de glob dos testes que leem a configuração do lint como dado (`files` dos overrides do .oxlintrc.json).
// Cobre o que a configuração usa: `*`, `**`, `**/`, `?`, classes `[jt]` e grupos `{a,b}`.
export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob.charAt(index);
    if (char === '*' && glob.charAt(index + 1) === '*') {
      const slash = glob.charAt(index + 2) === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '[' && glob.indexOf(']', index + 2) > index) {
      // Classe de caracteres (`[jt]`): vale como está, sem escapar os colchetes.
      const end = glob.indexOf(']', index + 2);
      source += glob.slice(index, end + 1);
      index = end;
    } else if (char === '{') {
      source += '(?:';
    } else if (char === '}') {
      source += ')';
    } else if (char === ',' && source.includes('(?:')) {
      source += '|';
    } else {
      source += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}
