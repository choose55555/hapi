import React, { useState, useEffect } from 'react'
import { Box, Text, useStdout } from 'ink'
import { MessageBuffer, type BufferedMessage } from './messageBuffer'
import { useSwitchControls } from './useSwitchControls'

interface RemoteModeDisplayProps {
    messageBuffer: MessageBuffer
    logPath?: string
    onExit?: () => void
    onSwitchToLocal?: () => void
    agentLabel?: string
}

export const RemoteModeDisplay: React.FC<RemoteModeDisplayProps> = ({ messageBuffer, logPath, onExit, onSwitchToLocal, agentLabel = 'Claude' }) => {
    const [messages, setMessages] = useState<BufferedMessage[]>([])
    const { confirmationMode, actionInProgress } = useSwitchControls({
        onExit,
        onSwitch: onSwitchToLocal
    })
    const { stdout } = useStdout()
    const [size, setSize] = useState(() => ({ width: stdout.columns || 80, height: stdout.rows || 24 }))
    useEffect(() => {
        if (process.platform !== 'win32') return
        const resize = () => setSize({ width: stdout.columns || 80, height: stdout.rows || 24 })
        stdout.on('resize', resize)
        return () => { stdout.off('resize', resize) }
    }, [stdout])
    const terminalWidth = process.platform === 'win32' ? Math.max(1, size.width) : (stdout.columns || 80)
    const terminalHeight = process.platform === 'win32' ? Math.max(1, size.height) : (stdout.rows || 24)

    useEffect(() => {
        setMessages(messageBuffer.getMessages())
        
        const unsubscribe = messageBuffer.onUpdate((newMessages) => {
            setMessages(newMessages)
        })

        return () => {
            unsubscribe()
        }
    }, [messageBuffer])

    const getMessageColor = (type: BufferedMessage['type']): string => {
        switch (type) {
            case 'user': return 'magenta'
            case 'assistant': return 'cyan'
            case 'system': return 'blue'
            case 'tool': return 'yellow'
            case 'result': return 'green'
            case 'status': return 'gray'
            default: return 'white'
        }
    }

    const formatMessage = (msg: BufferedMessage): string => {
        const lines = msg.content.split('\n')
        const maxLineLength = terminalWidth - 10 // Account for borders and padding
        return lines.map(line => {
            if (line.length <= maxLineLength) return line
            const chunks: string[] = []
            for (let i = 0; i < line.length; i += maxLineLength) {
                chunks.push(line.slice(i, i + maxLineLength))
            }
            return chunks.join('\n')
        }).join('\n')
    }

    if (process.platform === 'win32') {
        // Reserve the terminal's last row so Ink never scrolls while repainting.
        // One explicit line per Text, truncated by Ink's display-cell aware
        // renderer, avoids JS length/slice treating Chinese as single cells.
        const height = Math.max(1, terminalHeight - 1)
        const footerRows = Math.min(3, Math.max(0, height - 1))
        const bodyRows = Math.max(0, height - footerRows - 1)
        const lines = messages.flatMap(msg => msg.content.replace(/\r/g, '').split('\n')
            .map((content, index) => ({ ...msg, id: msg.id + ':' + index, content })))
        const hint = actionInProgress === 'exiting'
            ? 'Exiting...'
            : actionInProgress === 'switching'
                ? 'Switching to local mode...'
                : confirmationMode === 'exit'
                    ? 'Press Ctrl-C again to exit'
                    : confirmationMode === 'switch'
                        ? 'Press space again to switch to local mode'
                        : 'Press space twice to switch to local mode'
        return (
            <Box flexDirection="column" width={terminalWidth} height={height} overflow="hidden">
                <Box height={1} flexShrink={0}>
                    <Text color="gray" wrap="truncate-end">{'Remote Mode - ' + agentLabel + ' Messages'}</Text>
                </Box>
                {bodyRows > 0 && (
                    <Box flexDirection="column" height={bodyRows} flexShrink={0} overflow="hidden">
                        {lines.length === 0
                            ? <Text color="gray" wrap="truncate-end">{'Waiting for messages...'}</Text>
                            : lines.slice(-bodyRows).map(msg => (
                                <Box key={msg.id} height={1} flexShrink={0}>
                                    <Text color={getMessageColor(msg.type)} wrap="truncate-end">{msg.content}</Text>
                                </Box>
                            ))}
                    </Box>
                )}
                {footerRows > 0 && (
                    <Box height={footerRows} flexShrink={0} flexDirection="column" overflow="hidden">
                        <Text color="green" wrap="truncate-end">{onSwitchToLocal ? hint : 'Remote control active'}</Text>
                        {footerRows > 1 && <Text color="gray" wrap="truncate-end">{'Press Ctrl-C twice to exit'}</Text>}
                        {footerRows > 2 && <Text color="gray" wrap="truncate-end">{process.env.HAPI_WORKBENCH_AUTO_LOCAL === '1'
                            ? 'Return to local after the turn when queue is empty'
                            : 'Continue on phone or switch back here'}</Text>}
                    </Box>
                )}
            </Box>
        )
    }

    return (
        <Box flexDirection="column" width={terminalWidth} height={terminalHeight}>
            {/* Main content area with logs */}
            <Box 
                flexDirection="column" 
                width={terminalWidth}
                height={terminalHeight - 4}
                borderStyle="round"
                borderColor="gray"
                paddingX={1}
                overflow="hidden"
            >
                <Box flexDirection="column" marginBottom={1}>
                    <Text color="gray" bold>📡 Remote Mode - {agentLabel} Messages</Text>
                    <Text color="gray" dimColor>{'─'.repeat(Math.min(terminalWidth - 4, 60))}</Text>
                </Box>
                
                <Box flexDirection="column" height={terminalHeight - 10} overflow="hidden">
                    {messages.length === 0 ? (
                        <Text color="gray" dimColor>Waiting for messages...</Text>
                    ) : (
                        // Show only the last messages that fit in the available space
                        messages.slice(-Math.max(1, terminalHeight - 10)).map((msg) => (
                            <Box key={msg.id} flexDirection="column" marginBottom={1}>
                                <Text color={getMessageColor(msg.type)} dimColor>
                                    {formatMessage(msg)}
                                </Text>
                            </Box>
                        ))
                    )}
                </Box>
            </Box>

            {/* Modal overlay at the bottom */}
            <Box 
                width={terminalWidth}
                borderStyle="round"
                borderColor={
                    actionInProgress ? "gray" :
                    confirmationMode === 'exit' ? "red" : 
                    confirmationMode === 'switch' ? "yellow" : 
                    "green"
                }
                paddingX={2}
                justifyContent="center"
                alignItems="center"
                flexDirection="column"
            >
                <Box flexDirection="column" alignItems="center">
                    {actionInProgress === 'exiting' ? (
                        <Text color="gray" bold>
                            Exiting...
                        </Text>
                    ) : actionInProgress === 'switching' ? (
                        <Text color="gray" bold>
                            Switching to local mode...
                        </Text>
                    ) : confirmationMode === 'exit' ? (
                        <Text color="red" bold>
                            ⚠️  Press Ctrl-C again to exit completely
                        </Text>
                    ) : confirmationMode === 'switch' ? (
                        <Text color="yellow" bold>
                            ⏸️  Press space again to switch to local mode
                        </Text>
                    ) : (
                        <Text color="green" bold>
                            {onSwitchToLocal
                                ? '📱 Press space to switch to local mode • Ctrl-C to exit'
                                : '📱 Ctrl-C to exit'}
                        </Text>
                    )}
                    {process.env.DEBUG && logPath && (
                        <Text color="gray" dimColor>
                            Debug logs: {logPath}
                        </Text>
                    )}
                </Box>
            </Box>
        </Box>
    )
}
