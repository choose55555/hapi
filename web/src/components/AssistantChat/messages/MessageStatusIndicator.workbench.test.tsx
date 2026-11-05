import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MessageStatusIndicator } from './MessageStatusIndicator'
import { setSendFailureLabel } from '@/lib/sendFailureLabels'
afterEach(() => { cleanup(); setSendFailureLabel('fixture-id') })
describe('attachment send failure wording', () => {
    it('shows a definite failure in Chinese and retries by the existing callback', () => {
        const retry = vi.fn()
        setSendFailureLabel('fixture-id', '未发送，点此重发')
        render(<MessageStatusIndicator status="failed" localId="fixture-id" onRetry={retry} />)
        fireEvent.click(screen.getByRole('button', { name: '未发送，点此重发' }))
        expect(retry).toHaveBeenCalledTimes(1)
    })
    it('does not label an uncertain delivery as unsent', () => {
        setSendFailureLabel('fixture-id', '暂时无法确认是否送达，点此重试（不会重复发送）')
        render(<MessageStatusIndicator status="failed" localId="fixture-id" onRetry={() => {}} />)
        expect(screen.getByRole('button').textContent).toContain('暂时无法确认')
        expect(screen.queryByText('未发送，点此重发')).toBeNull()
    })
})
