'use client'

import { useChat, type Message } from 'ai/react'
import { useState, useRef } from 'react'
import { ChatList } from '@/components/chat-list'
import { ChatPanel } from '@/components/chat-panel'
import { ChatScrollAnchor } from '@/components/chat-scroll-anchor'
import { EmptyScreen } from '@/components/empty-screen'
import { cn } from '@/lib/utils'
import { toast } from 'react-hot-toast'

export interface ChatProps extends React.ComponentProps<'div'> {
  initialMessages?: Message[]
  id?: string
}

export function Chat({ id, initialMessages, className }: ChatProps) {
  // ✅ FIX: Track the actual documentId and fileName separately
  const [documentId, setDocumentId] = useState<string | null>(null)
  const [documentFileName, setDocumentFileName] = useState<string | null>(null)

  const { messages, append, reload, stop, isLoading, input, setInput } =
    useChat({
      api: '/api/chat',
      initialMessages,
      id,
      body: { 
        id,
        documentId
      },
      onResponse(response: any) {
        console.log('onResponse', response)
        if (response.status !== 200) {
          toast.error(response.statusText)
        }
      }
    })

  // Handle document upload
  const handleDocumentUpload = async (documentData: any) => {
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          documentUpload: documentData,
          messages: []
        }),
      })

      if (!response.ok) {
        throw new Error('Upload failed')
      }

      const result = await response.json()
      
      // ✅ FIX: Store both documentId and fileName
      setDocumentId(documentData.documentId)
      setDocumentFileName(documentData.fileName)
      
      console.log(`✅ Document uploaded - ID: ${documentData.documentId}, FileName: ${documentData.fileName}`)

      // Add the upload confirmation message to chat
      await append({
        id: Date.now().toString(),
        role: 'assistant',
        content: result.message.content,
      })

      toast.success('Document uploaded successfully!')
    } catch (error) {
      console.error('Document upload error:', error)
      toast.error('Failed to upload document')
      throw error
    }
  }

  return (
    <>
      <div className={cn('pb-[200px] pt-4 md:pt-10', className)}>
        {messages.length ? (
          <>
            <ChatList messages={messages} />
            <ChatScrollAnchor trackVisibility={isLoading} />
          </>
        ) : (
          <EmptyScreen setInput={setInput} />
        )}
      </div>
      <ChatPanel
        id={id}
        isLoading={isLoading}
        stop={stop}
        append={append}
        reload={reload}
        messages={messages}
        input={input}
        setInput={setInput}
        onDocumentUpload={handleDocumentUpload}
      />
    </>
  )
}