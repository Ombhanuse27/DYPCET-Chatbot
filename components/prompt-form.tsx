import { UseChatHelpers } from 'ai/react'
import * as React from 'react'
import Textarea from 'react-textarea-autosize'
import { Button } from '@/components/ui/button'
import { IconArrowElbow } from '@/components/ui/icons'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger
} from '@/components/ui/tooltip'
import { useEnterSubmit } from '@/lib/hooks/use-enter-submit'
import { Paperclip, X, FileText } from 'lucide-react'
import toast from 'react-hot-toast'

export interface PromptProps
  extends Pick<UseChatHelpers, 'input' | 'setInput'> {
  onSubmit: (value: string) => Promise<void>
  isLoading: boolean
  onDocumentUpload?: (documentData: any) => Promise<void>
}

export function PromptForm({
  onSubmit,
  input,
  setInput,
  isLoading,
  onDocumentUpload
}: PromptProps) {
  const { formRef, onKeyDown } = useEnterSubmit()
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  
  const [uploadedFile, setUploadedFile] = React.useState<File | null>(null)
  const [isUploading, setIsUploading] = React.useState(false)

  React.useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }, [])

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Validate file type
    const validTypes = ['application/pdf', 'text/plain', 'text/markdown']
    if (!validTypes.includes(file.type)) {
      toast.error('Please upload a PDF, TXT, or MD file')
      return
    }

    // Validate file size (10MB max)
    if (file.size > 10 * 1024 * 1024) {
      toast.error('File size must be less than 10MB')
      return
    }

    setUploadedFile(file)
    setIsUploading(true)

    try {
      // Convert file to base64
      const base64Content = await fileToBase64(file)
      
      // Generate unique document ID
      const documentId = `doc_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`

      // Call the upload handler
      if (onDocumentUpload) {
        await onDocumentUpload({
          documentId,
          fileName: file.name,
          fileContent: base64Content,
          fileType: file.type
        })
      }

      toast.success(`${file.name} uploaded successfully!`)
    } catch (error) {
      console.error('Upload error:', error)
      toast.error('Failed to upload document')
      setUploadedFile(null)
    } finally {
      setIsUploading(false)
    }
  }

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.readAsDataURL(file)
      reader.onload = () => {
        const result = reader.result as string
        // Remove the data URL prefix (e.g., "data:application/pdf;base64,")
        const base64 = result.split(',')[1]
        resolve(base64)
      }
      reader.onerror = reject
    })
  }

  const removeFile = () => {
    setUploadedFile(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  return (
    <form
      onSubmit={async e => {
        e.preventDefault()
        if (!input?.trim()) {
          return
        }
        setInput('')
        await onSubmit(input)
      }}
      ref={formRef}
    >
      <div className="relative flex max-h-60 w-full grow flex-col overflow-hidden bg-background sm:rounded-md sm:border">
        {/* File attachment indicator */}
        {uploadedFile && (
          <div className="flex items-center gap-2 border-b px-4 py-2 text-sm">
            <FileText className="h-4 w-4 text-blue-500" />
            <span className="flex-1 truncate text-muted-foreground">
              {uploadedFile.name}
            </span>
            <button
              type="button"
              onClick={removeFile}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        <div className="relative flex items-center pr-16">
          <Textarea
            ref={inputRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            rows={1}
            value={input}
            onChange={e => setInput(e.target.value)}
            placeholder="Send a message..."
            spellCheck={false}
            className="min-h-[60px] w-full resize-none bg-transparent px-4 py-[1.3rem] focus-within:outline-none sm:text-sm"
          />
          
          <div className="absolute right-0 top-4 flex items-center gap-2 sm:right-4">
            {/* File upload button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  disabled={isUploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="h-8 w-8"
                >
                  <Paperclip className="h-4 w-4" />
                  <span className="sr-only">Upload document</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Upload document (PDF, TXT, MD)</TooltipContent>
            </Tooltip>

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.txt,.md"
              onChange={handleFileSelect}
              className="hidden"
            />

            {/* Send button */}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="submit"
                  size="icon"
                  disabled={isLoading || input === ''}
                  className="h-8 w-8"
                >
                  <IconArrowElbow />
                  <span className="sr-only">Send message</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Send message</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </div>
    </form>
  )
}