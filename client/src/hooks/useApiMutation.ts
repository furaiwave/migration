import { useCallback, useRef, useState } from "react";

export type MutationState<TData, TError = unknown> = 
    { readonly status: 'idle'; readonly data: null; readonly error: null}  
    | { readonly status: 'pending'; readonly data: null; readonly error: null }
    | { readonly status: 'success'; readonly data: TData; readonly error: null }
    | { readonly status: 'error'; readonly data: null; readonly error: TError }

const IDLE = { status: 'idle', data: null, error: null } as const

export interface useApiMutationResult<TInput, TData, TError> {
    readonly state: MutationState<TData, TError>
    readonly isPending: boolean
    readonly mutate: (input: TInput) => Promise<TData>
    readonly reset: () => void
}

export function useApiMutation<const TInput, TData, TError = unknown>(
    fn: (input: TInput) => Promise<TData>,
): useApiMutationResult<TInput, TData, TError> {
    const [state, setState] = useState<MutationState<TData, TError>>(IDLE)
    const callId = useRef(0)
    const mutate =  useCallback(
        async(input: TInput): Promise<TData> => {
            const id = ++callId.current
            setState({ status: 'pending', data: null, error: null })
            try{
                const data = await fn(input)
                if(id === callId.current) setState({ status: 'success', data,  error: null })
                return data
            } catch(err){
                if(id === callId.current) setState({ status: 'error', data: null, error: err as TError })
                throw err
            } 
        },
        [fn]
    )
    const reset = useCallback(() => {
        callId.current++
        setState(IDLE)
    }, [])
    return { state, isPending: state.status === 'pending', mutate, reset }
}