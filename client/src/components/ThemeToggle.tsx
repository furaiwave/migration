import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { translate } from '@/i18n';
import { setTheme, useTheme } from '@/lib/theme';

export function ThemeToggle() {
  const theme = useTheme();
  const label = theme === 'dark' ? translate('Світла тема') : translate('Темна тема');

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      aria-label={label}
      title={label}
    >
      {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
      {label}
    </Button>
  );
}
