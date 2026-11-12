import { Languages } from 'lucide-react';
import { useLanguage, translate, isLanguage, LANGUAGES, setLanguage } from '@/i18n';

export function LanguagePicker() {
  const language = useLanguage();
  return (
    <label className="flex shrink-0 items-center gap-2 text-xs">
      <Languages className="size-4 text-muted-foreground" aria-hidden="true" />
      <select
        aria-label={translate("Мова інтерфейсу")}
        value={language}
        onChange={(event) => { if (isLanguage(event.target.value)) setLanguage(event.target.value); }}
        className="h-8 max-w-40 cursor-pointer rounded-md border border-input bg-background px-2 text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {LANGUAGES.map(({ code, label }) => <option key={code} value={code} lang={code}>{label}</option>)}
      </select>
    </label>
  );
}
