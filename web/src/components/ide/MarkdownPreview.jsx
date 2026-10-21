import { Box, Typography } from '@mui/material';
import Markdown from '../Markdown.jsx';

// Read-only rendering of a Markdown document (raw HTML and remote images are never rendered, see Markdown.jsx).
export default function MarkdownPreview({ source, content }) {
  return (
    <Box role="document" aria-label={`Markdown preview of ${source}`} data-testid="markdown-preview" sx={{ height: '100%', overflow: 'auto', bgcolor: 'background.paper' }}>
      <Box sx={{ maxWidth: 900, mx: 'auto', px: 3, py: 2 }}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>Preview of {source} (read-only)</Typography>
        <Markdown>{content}</Markdown>
      </Box>
    </Box>
  );
}
