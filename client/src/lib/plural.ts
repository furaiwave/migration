import { getLanguage } from '@/i18n';

/** Select the language's cardinal form, including Polish and Ukrainian few/many. */
export function plural(n: number, one: string, few: string, many: string): string {
    const form = new Intl.PluralRules(getLanguage()).select(n);
    return form === 'one' ? one : form === 'few' ? few : many;
}
