export type SessionRowStatusInput = {
    active: boolean
    thinking: boolean
    backgroundTaskCount?: number | null
    pendingRequestsCount?: number | null
    lastError?: { message?: string | null } | null
    lifecycleState?: string | null
    inRunningSection: boolean
}

export type SessionRowStatus = {
    isWaiting: boolean
    isBusy: boolean
    hasError: boolean
    isArchived: boolean
    titleStatus: string | null
    tone: 'warning' | 'success' | 'error' | 'hint' | null
    errorTitle?: string
    showTrailingPendingCount: boolean
}

export function sessionRowStatus(input: SessionRowStatusInput): SessionRowStatus {
    const pending = input.pendingRequestsCount ?? 0
    const isWaiting = input.active && pending > 0
    const isRunning = input.active && input.thinking
    const isBackgroundOnly = input.active && !input.thinking && (input.backgroundTaskCount ?? 0) > 0
    const isBusy = input.active && !isWaiting && (isRunning || isBackgroundOnly)
    const hasError = !isWaiting && !isBusy && Boolean(input.lastError)
    const isArchived = !input.active && !hasError && input.lifecycleState === 'archived'

    let titleStatus: string | null = null
    let tone: SessionRowStatus['tone'] = null
    let errorTitle: string | undefined
    if (!input.inRunningSection) {
        if (isWaiting) {
            titleStatus = pending > 1 ? `等待 ${pending}` : '等待'
            tone = 'warning'
        } else if (isBusy) {
            titleStatus = '运行'
            tone = 'success'
        } else if (hasError) {
            titleStatus = '出错'
            tone = 'error'
            errorTitle = input.lastError?.message ?? undefined
        } else if (input.active) {
            titleStatus = '空闲'
            tone = 'hint'
        } else {
            titleStatus = isArchived ? '已归档' : '离线'
            tone = 'hint'
        }
    }

    return {
        isWaiting,
        isBusy,
        hasError,
        isArchived,
        titleStatus,
        tone,
        errorTitle,
        showTrailingPendingCount: false
    }
}

export type SessionRowVisible = {
    text: string | null
    errorTitle?: string
    showTrailingPendingCount: false
}

export function sessionRowVisibleText(
    input: SessionRowStatusInput & { urgentAttention?: boolean }
): SessionRowVisible {
    const status = sessionRowStatus(input)
    if (input.inRunningSection) {
        return { text: null, showTrailingPendingCount: false }
    }
    if (input.urgentAttention || status.isWaiting) {
        return {
            text: status.isWaiting ? status.titleStatus : '等待',
            showTrailingPendingCount: false
        }
    }
    if (status.titleStatus) {
        return {
            text: status.titleStatus,
            errorTitle: status.tone === 'error' ? status.errorTitle : undefined,
            showTrailingPendingCount: false
        }
    }
    return { text: null, showTrailingPendingCount: false }
}
