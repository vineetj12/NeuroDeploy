import React, { useState } from 'react';
import { Card } from '../components/ui/Card';
import { Button } from '../components/ui/Button';
import { saveCredential, saveAIModel, saveModelKey, updateUser } from '../api/client';
import './SettingsPage.css';

const SettingsPage: React.FC = () => {
  const [vercelToken, setVercelToken] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [customWebhook, setCustomWebhook] = useState('');

  const [activeProvider, setActiveProvider] = useState<'GEMINI' | 'OPENAI' | 'ANTHROPIC'>('GEMINI');

  const [geminiKey, setGeminiKey] = useState('');
  const [geminiModel, setGeminiModel] = useState('gemini-2.5-flash');

  const [openaiKey, setOpenaiKey] = useState('');
  const [openaiModel, setOpenaiModel] = useState('gpt-4o');

  const [anthropicKey, setAnthropicKey] = useState('');
  const [anthropicModel, setAnthropicModel] = useState('claude-3-5-sonnet');

  const [isSaving, setIsSaving] = useState(false);

  const handleSave = async () => {
    setIsSaving(true);
    try {
      if (vercelToken) await saveCredential('VERCEL', 'vercel-token', vercelToken);
      if (githubToken) await saveCredential('GITHUB', 'github-token', githubToken);
      if (customWebhook) await saveCredential('CUSTOM', 'custom-webhook', customWebhook);
      
      let selectedModelIdToSave = '';

      if (geminiKey) {
        const model = await saveAIModel(geminiModel, 'GEMINI');
        await saveModelKey(model.id, geminiKey);
        if (activeProvider === 'GEMINI') selectedModelIdToSave = model.id;
      }
      if (openaiKey) {
        const model = await saveAIModel(openaiModel, 'OPENAI');
        await saveModelKey(model.id, openaiKey);
        if (activeProvider === 'OPENAI') selectedModelIdToSave = model.id;
      }
      if (anthropicKey) {
        const model = await saveAIModel(anthropicModel, 'ANTHROPIC');
        await saveModelKey(model.id, anthropicKey);
        if (activeProvider === 'ANTHROPIC') selectedModelIdToSave = model.id;
      }
      
      if (selectedModelIdToSave) {
        await updateUser({ selectedModelId: selectedModelIdToSave });
      } else if (
        (activeProvider === 'GEMINI' && !geminiKey) ||
        (activeProvider === 'OPENAI' && !openaiKey) ||
        (activeProvider === 'ANTHROPIC' && !anthropicKey)
      ) {
        alert('Warning: You selected ' + activeProvider + ' as active, but did not provide an API key for it. Active model was not changed.');
      }
      
      alert('Settings saved successfully!');
    } catch (err) {
      alert('Failed to save settings: ' + String(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="settings-page">
      <div className="page-header">
        <h1>Settings & Integrations</h1>
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? 'Saving...' : 'Save Configuration'}
        </Button>
      </div>

      <div className="settings-content">
        <Card title="Deployment & Source Control" className="settings-card">
          <div className="form-group">
            <label>Vercel Access Token</label>
            <input 
              type="password" 
              placeholder="vrcl_..." 
              className="input-field" 
              value={vercelToken}
              onChange={(e) => setVercelToken(e.target.value)}
            />
            <span className="help-text">Used to fetch deployment logs and project details.</span>
          </div>

          <div className="form-group mt-4">
            <label>GitHub Personal Access Token</label>
            <input 
              type="password" 
              placeholder="ghp_..." 
              className="input-field" 
              value={githubToken}
              onChange={(e) => setGithubToken(e.target.value)}
            />
            <span className="help-text">Required scopes: repo, workflow, write:packages.</span>
          </div>

          <div className="form-group mt-4">
            <label>Custom Webhook URL</label>
            <input 
              type="url" 
              placeholder="https://your-domain.com/webhook" 
              className="input-field" 
              value={customWebhook}
              onChange={(e) => setCustomWebhook(e.target.value)}
            />
            <span className="help-text">Optional hook triggered on auto-fix completion.</span>
          </div>
        </Card>

        <Card title="AI Providers" className="settings-card mt-4">
          <div style={{ marginBottom: '16px', fontSize: '14px', color: 'var(--text-secondary)' }}>
            Select your active AI provider below. The active provider will be used to automatically fix your broken deployments.
          </div>
          <div className="ai-provider-grid">
            {/* Gemini */}
            <div className="provider-block">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <h3 style={{ margin: 0 }}>Google Gemini</h3>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input 
                    type="radio" 
                    name="activeProvider" 
                    checked={activeProvider === 'GEMINI'} 
                    onChange={() => setActiveProvider('GEMINI')} 
                  />
                  <span style={{ fontSize: '13px' }}>Set Active</span>
                </label>
              </div>
              <div className="form-group">
                <label>API Key</label>
                <input 
                  type="password" 
                  placeholder="AIza..." 
                  className="input-field"
                  value={geminiKey}
                  onChange={(e) => setGeminiKey(e.target.value)}
                />
              </div>
              <div className="form-group mt-2">
                <label>Default Model</label>
                <select 
                  className="input-field select-field"
                  value={geminiModel}
                  onChange={(e) => setGeminiModel(e.target.value)}
                >
                  <option value="gemini-2.5-flash">Gemini 2.5 Flash (Fast)</option>
                  <option value="gemini-2.5-pro">Gemini 2.5 Pro (Accurate)</option>
                </select>
              </div>
            </div>

            {/* OpenAI */}
            <div className="provider-block mt-4 pt-4" style={{ borderTop: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <h3 style={{ margin: 0 }}>OpenAI</h3>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input 
                    type="radio" 
                    name="activeProvider" 
                    checked={activeProvider === 'OPENAI'} 
                    onChange={() => setActiveProvider('OPENAI')} 
                  />
                  <span style={{ fontSize: '13px' }}>Set Active</span>
                </label>
              </div>
              <div className="form-group">
                <label>API Key</label>
                <input 
                  type="password" 
                  placeholder="sk-..." 
                  className="input-field"
                  value={openaiKey}
                  onChange={(e) => setOpenaiKey(e.target.value)}
                />
              </div>
              <div className="form-group mt-2">
                <label>Default Model</label>
                <select 
                  className="input-field select-field"
                  value={openaiModel}
                  onChange={(e) => setOpenaiModel(e.target.value)}
                >
                  <option value="gpt-4o">GPT-4o</option>
                  <option value="gpt-4o-mini">GPT-4o Mini</option>
                  <option value="o1-preview">o1 Preview</option>
                </select>
              </div>
            </div>

            {/* Anthropic */}
            <div className="provider-block mt-4 pt-4" style={{ borderTop: '1px solid var(--border-color)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <h3 style={{ margin: 0 }}>Anthropic</h3>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input 
                    type="radio" 
                    name="activeProvider" 
                    checked={activeProvider === 'ANTHROPIC'} 
                    onChange={() => setActiveProvider('ANTHROPIC')} 
                  />
                  <span style={{ fontSize: '13px' }}>Set Active</span>
                </label>
              </div>
              <div className="form-group">
                <label>API Key</label>
                <input 
                  type="password" 
                  placeholder="sk-ant-..." 
                  className="input-field"
                  value={anthropicKey}
                  onChange={(e) => setAnthropicKey(e.target.value)}
                />
              </div>
              <div className="form-group mt-2">
                <label>Default Model</label>
                <select 
                  className="input-field select-field"
                  value={anthropicModel}
                  onChange={(e) => setAnthropicModel(e.target.value)}
                >
                  <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
                  <option value="claude-3-opus">Claude 3 Opus</option>
                  <option value="claude-3-5-haiku">Claude 3.5 Haiku</option>
                </select>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
};

export default SettingsPage;
