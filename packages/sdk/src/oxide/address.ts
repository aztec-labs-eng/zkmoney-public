/** Whether two hex addresses are the same, whatever the case of their letters. */
export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
