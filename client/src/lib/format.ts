export const formatDuration = (ms: number): string => {
    const s = Math.round(ms / 1000)
    return s < 60 ? `${s} с` : `${Math.floor(s / 60)} хв ${String(s % 60).padStart(2, '0')} с`
}
