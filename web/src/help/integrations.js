// Step-by-step setup guides for each AI provider an administrator can add under Admin > Server (AI services).
// One guide per connection type in admin/Servers.jsx. Every guide needs 'provider.read', like "Connect AI models".
// Style: short, friendly, active voice. Names of fields and buttons match the dialog exactly.
const ADMIN_AI = { requires: 'provider.read', group: 'Integration guides' };

export const INTEGRATION_TOPICS = [
  { id: 'ai-providers', title: 'Choose a provider', ...ADMIN_AI, body: `
These guides walk you through connecting each AI provider to this app. Pick the one that matches where your models run, then follow its guide from start to finish.

## Which provider?

| Guide | **Type** in the list | Where the model runs | You need |
|---|---|---|---|
| [OpenAI](#ai-openai) | OpenAI (ChatGPT) | OpenAI's cloud | API key |
| [Anthropic](#ai-anthropic) | Anthropic | Anthropic's cloud | API key |
| [Google Gemini](#ai-gemini) | Google Gemini | Google's cloud | AI Studio API key |
| [Mistral AI](#ai-mistral) | Mistral AI | Mistral's cloud | API key |
| [AWS Bedrock](#ai-bedrock) | AWS Bedrock | Your AWS account | Region, plus AWS keys or an IAM role |
| [Google Vertex AI](#ai-vertex) | Google Vertex AI | Your Google Cloud project | Project ID, plus a service account or default credentials |
| [Azure OpenAI](#ai-azure) | Azure OpenAI | Your Azure resource | Endpoint and key |
| [LM Studio](#ai-lmstudio) | LM Studio | Your own hardware | Server address |
| [Ollama](#ai-ollama) | Ollama | Your own hardware | Server address |
| [Self-hosted servers](#ai-generic) | OpenAPI-compatible (self-hosted) | Your own hardware | Server address |

> [!INFO]
> Cloud providers bill per token. Bedrock, Vertex AI, and Azure OpenAI bill through your own cloud account, which helps when your organization wants one invoice and one set of access rules. LM Studio, Ollama, and self-hosted servers cost nothing per token and keep prompts on your network.

## Steps every guide shares
1. Go to **Admin**, then **Server (AI services)**, and select **Add connection**.
2. Enter a **Name** that users will recognize, then pick the **Type**.
3. Fill in the fields that type needs. The guide lists each one.
4. Select **Connect & load models**. A message under the button tells you how many models the provider offers, or why it could not connect.
5. Choose your models in the **Models to make available** list. You can also type an ID and press <kbd>Enter</kbd>.
6. Select **Save**, then confirm it's you when the prompt appears.
7. Select **Test** on the connection's card. Then open **Edit** on a model to set its context window, prices, and defaults. See [Connect AI models](#admin-ai).

## Before you start
- **The server makes the call.** The app's server connects to the provider, not the user's browser. So the server must reach the provider's address. In a self-hosted setup, \`localhost\` means the server machine itself.
- **Keep keys private.** The app encrypts every key you enter and never shows it again. To replace a key, edit the connection and type a new one. Give each key only the permissions it needs, and set a spending limit with the provider.
- **Know where data goes.** The server sends each prompt, plus any file text or attachment the agent reads, to the provider you choose. Check that provider's data terms against your organization's rules.
- **Limit who sees a connection.** Use **Restrict to roles (empty = all)** to show a connection to certain roles only, and **Help text for users (optional)** to say what the models suit and where data goes.

See [Troubleshooting connections](#ai-troubleshooting) when a step fails.` },

  { id: 'ai-openai', title: 'OpenAI', ...ADMIN_AI, body: `
Connect OpenAI's hosted API, the home of the ChatGPT models.

## What you need
- An OpenAI account with billing set up.
- An API key. Create one on the **API keys** page of the [OpenAI platform](https://platform.openai.com/api-keys). Name it after this app so you can find it later.

## Connect it
1. Go to **Admin**, then **Server (AI services)**, and select **Add connection**.
2. Set **Name** to something like \`OpenAI\`.
3. Leave **Type** on **OpenAI (ChatGPT)**.
4. Leave **Base URL** as \`https://api.openai.com/v1\`.
5. Paste your key into **API key / secret**.
6. Select **Connect & load models**, choose your models, and select **Save**.

## Check it
Select **Test** on the card. A green message lists how many models OpenAI offers. Then open the **Agent** or **Chat** page as a normal user and send a short message.

## Good to know
- The list includes every model your key can reach, including ones that do not chat, such as image and speech models. Pick only chat models.
- Turn on **Files & images (users can attach them for this model)** only for models that read them.
- To reach OpenAI through a proxy or gateway, change **Base URL** to the gateway's address. The same type also works for other hosted services that copy OpenAI's API.
- Enter the model's prices under **Edit** so the [reports](#admin-reports) show real costs.

## If it fails
- **401 or "incorrect API key":** copy the key again. A key shows in full only once, when you create it.
- **429 or "quota":** the account has no credit or hit a rate limit. Check billing in the OpenAI platform.
- **A model is missing:** your key's project may not have access. Type the ID into **Add model ID** under the connection.` },

  { id: 'ai-anthropic', title: 'Anthropic (Claude)', ...ADMIN_AI, body: `
Connect Anthropic's hosted API to use the Claude models.

## What you need
- An Anthropic Console account with billing set up.
- An API key from the **API keys** page of the Claude Console. Name it after this app.

## Connect it
1. Go to **Admin**, then **Server (AI services)**, and select **Add connection**.
2. Set **Name** to something like \`Anthropic\`.
3. Set **Type** to **Anthropic**.
4. Leave **Base URL** as \`https://api.anthropic.com\`.
5. Paste your key into **API key / secret**.
6. Select **Connect & load models**, choose your models, and select **Save**.

## Check it
Select **Test** on the card. A green message lists how many models Anthropic offers. Then send a short message from **Chat**.

## Set thinking for each model
Claude models can reason before they answer. Open **Edit** on each model and pick a **Thinking** setting:
- **Adaptive** for current Claude models. The model decides how much to think.
- **Budget** for older Claude models. Then set **Thinking budget (tokens)**, at least 1,024.
- **Off** when you want faster, cheaper answers.

## Good to know
- Claude models read images and PDFs, so you can turn on **Files & images (users can attach them for this model)**.
- Most Claude models handle tool calls well, so leave **Subagents** on.
- Change **Base URL** only to reach Anthropic through a proxy or gateway.
- To use Claude through your own cloud account instead, see [AWS Bedrock](#ai-bedrock).

## If it fails
- **401 "authentication_error":** the key is wrong or revoked. Create a new one.
- **Credit balance too low:** add credit in the Claude Console.
- **429 or "overloaded":** wait and retry, or ask Anthropic to raise your rate limit.` },

  { id: 'ai-gemini', title: 'Google Gemini', ...ADMIN_AI, body: `
Connect Gemini through Google AI Studio, the quickest way to use Google's models with just an API key.

## What you need
- A Google account with access to [Google AI Studio](https://aistudio.google.com/apikey).
- An API key from the **Get API key** page. Link it to a Google Cloud project with billing for production use, since free keys have tight limits and may use prompts to improve Google's products.

## Connect it
1. Go to **Admin**, then **Server (AI services)**, and select **Add connection**.
2. Set **Name** to something like \`Gemini\`.
3. Set **Type** to **Google Gemini**.
4. Leave **Base URL** as \`https://generativelanguage.googleapis.com/v1beta/openai/\`. This is Google's OpenAI-compatible endpoint.
5. Paste your key into **API key / secret**.
6. Select **Connect & load models**, choose your models, and select **Save**.

## Check it
Select **Test** on the card. A green message lists how many models Google offers. Then send a short message from **Chat**.

## Good to know
- The app strips the \`models/\` prefix from IDs. Pick \`gemini-…\`, not \`models/gemini-…\`.
- Gemini 3 models return a "thought signature" with each tool call. The app keeps and replays it for you, so tool use works with no setup.
- Gemini models read images and PDFs, so you can turn on **Files & images (users can attach them for this model)**.
- Change **Base URL** only to use a proxy or gateway.
- For data that must stay inside your Google Cloud project, use [Google Vertex AI](#ai-vertex) instead.

## If it fails
- **400 "API key not valid":** create a new key in AI Studio and paste it again.
- **429 "quota exceeded":** the free tier ran out. Enable billing on the key's project.
- **A model is missing:** some models are preview-only. Type the ID into **Add model ID**.` },

  { id: 'ai-mistral', title: 'Mistral AI', ...ADMIN_AI, body: `
Connect Mistral's hosted API, a good fit when you want European hosting.

## What you need
- An account at [console.mistral.ai](https://console.mistral.ai) with a plan that allows API use.
- An API key from the **API keys** page.

## Connect it
1. Go to **Admin**, then **Server (AI services)**, and select **Add connection**.
2. Set **Name** to something like \`Mistral\`.
3. Set **Type** to **Mistral AI**.
4. Leave **Base URL** as \`https://api.mistral.ai/v1\`.
5. Paste your key into **API key / secret**.
6. Select **Connect & load models**, choose your models, and select **Save**.

## Check it
Select **Test** on the card. A green message lists how many models Mistral offers. Then send a short message from **Chat**.

## Good to know
- Mistral accepts tool-call IDs of exactly nine letters or digits. The app converts IDs for you, even when a user switches models in the middle of a chat.
- Pick models that support tool calls for the agent. Turn **Subagents** off for any model that struggles with them.
- Change **Base URL** only to use a proxy or gateway.

## If it fails
- **401 "Unauthorized":** the key is wrong, or its workspace has no active plan.
- **429:** you hit a rate limit. Wait, or ask Mistral to raise it.
- **A model is missing:** type its ID into **Add model ID** under the connection.` },

  { id: 'ai-bedrock', title: 'AWS Bedrock', ...ADMIN_AI, body: `
Use models from several vendors, including Claude, through your own AWS account. Usage appears on your AWS bill and follows your AWS access rules.

## What you need
- An AWS account, and a **region** where Bedrock offers your models, such as \`us-east-1\`.
- Access to the models you want. In the AWS console, open **Amazon Bedrock**, then **Model access**, and request each model. Some vendors ask a few questions first. Access can take a few minutes.
- Credentials: either an access key pair, or an IAM role on the machine that runs this server.

## Create the permissions
Create an IAM policy with these permissions and attach it to the user or role:

\`\`\`json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "bedrock:InvokeModel",
      "bedrock:InvokeModelWithResponseStream",
      "bedrock:ListFoundationModels",
      "bedrock:ListInferenceProfiles"
    ],
    "Resource": "*"
  }]
}
\`\`\`

Narrow **Resource** to specific model or inference-profile ARNs once everything works.

## Connect it
1. Go to **Admin**, then **Server (AI services)**, and select **Add connection**.
2. Set **Name** to something like \`Bedrock\`.
3. Set **Type** to **AWS Bedrock**.
4. Enter your region in **AWS region**, for example \`us-east-1\`.
5. Fill in **API key / secret** one of two ways:
   - **Access keys:** enter \`ACCESS_KEY_ID:SECRET_ACCESS_KEY\`, joined by a colon. For temporary credentials, add the session token: \`ACCESS_KEY_ID:SECRET_ACCESS_KEY:SESSION_TOKEN\`.
   - **IAM role:** leave it empty. The server then uses its own AWS credentials, such as an instance role, a task role, or environment variables. This is the safer choice because no long-lived key sits in the app.
6. Select **Connect & load models**, choose your models, and select **Save**.

## Check it
Select **Test** on the card. A green message lists how many models Bedrock offers. Then send a short message from **Chat**.

## Good to know
- The list shows text models that support on-demand use, plus *inference profiles*. Newer models, including recent Claude models, often work only through a profile. Their IDs start with a region code, such as \`us.anthropic.…\` or \`eu.anthropic.…\`. Choose the profile whose prefix matches your data-residency needs.
- Set **Thinking** and prices per model under **Edit**. Bedrock prices differ from the vendor's own API, so check the AWS pricing page.
- You can add several Bedrock connections, for example one per region or per AWS account.

## If it fails
- **"AccessDeniedException":** the policy lacks an action, or you have not requested model access.
- **"on-demand throughput isn't supported":** use the inference profile ID of that model instead of the plain model ID.
- **"Could not resolve credentials":** you left the secret empty, but the server has no AWS credentials. Add keys, or attach a role to the host.
- **The list is empty:** check the region. Models differ from region to region.` },

  { id: 'ai-vertex', title: 'Google Vertex AI', ...ADMIN_AI, body: `
Use Gemini models inside your own Google Cloud project. Billing, quotas, and access rules all follow that project. This uses the native Vertex AI API, not the OpenAI-compatible Gemini endpoint.

## What you need
- A Google Cloud project with billing turned on.
- The **Vertex AI API** enabled for that project. In the Google Cloud console, open **APIs & Services**, then **Library**, and enable it.
- Credentials for the app, either a service-account key or default credentials from the host.

## Create a service account
1. In the Google Cloud console, open **IAM & Admin**, then **Service Accounts**, and create one, for example \`agentic-coding\`.
2. Grant it the **Vertex AI User** role (\`roles/aiplatform.user\`) on the project.
3. Open the account, go to **Keys**, then **Add key**, then **Create new key**, and choose **JSON**. The browser downloads the file once.

> [!WARNING]
> The key file grants access to your project. Paste it into the app, then delete the downloaded copy. Never commit it to a repository.

## Connect it
1. Go to **Admin**, then **Server (AI services)**, and select **Add connection**.
2. Set **Name** to something like \`Vertex AI\`.
3. Set **Type** to **Google Vertex AI**.
4. Enter your project's ID in **Google Cloud project ID**. Use the ID, such as \`my-project-123\`, not the display name.
5. Enter a region in **Location**, such as \`us-central1\`, or \`global\`. If you leave it empty, the app uses \`global\`.
6. In **API key / secret**, paste the whole contents of the JSON key file. Or leave it empty to use the server's *Application Default Credentials*, such as a service account attached to the virtual machine or container, or the \`GOOGLE_APPLICATION_CREDENTIALS\` environment variable.
7. Select **Connect & load models**, choose your models, and select **Save**.

## Check it
Select **Test** on the card. A green message lists how many models Vertex AI offers. Then send a short message from **Chat**.

## Good to know
- The app needs the project ID and refuses to save without it.
- If your organization blocks service-account keys, leave the secret empty and run the server with an attached service account.
- Some models exist only in certain locations. If a model is missing, try \`global\` or another region.
- Gemini models read images and PDFs, so you can turn on **Files & images (users can attach them for this model)**.

## If it fails
- **"The Vertex secret must be a service-account key in JSON form":** you pasted something other than the full JSON file.
- **403 "Permission denied":** the account lacks the Vertex AI User role, or the API is off.
- **"Could not load the default credentials":** you left the secret empty, but the host has no default credentials.` },

  { id: 'ai-azure', title: 'Azure OpenAI', ...ADMIN_AI, body: `
Use OpenAI models through your own Azure subscription. Azure routes requests by *deployment name*, so the models you offer here are your deployments.

## What you need
- An Azure subscription with access to Azure OpenAI.
- An Azure OpenAI resource. Create one in the Azure portal, or in Azure AI Foundry.
- At least one **deployment**: open your resource, choose **Deploy model**, pick a model, and give the deployment a name. Note the name exactly, because you enter it below.
- The resource's **endpoint** and a **key**. In the Azure portal, open your resource and go to **Keys and Endpoint**. Either key works.

## Connect it
1. Go to **Admin**, then **Server (AI services)**, and select **Add connection**.
2. Set **Name** to something like \`Azure OpenAI\`.
3. Set **Type** to **Azure OpenAI**.
4. Enter the resource address in **Endpoint**, in the form \`https://<resource>.openai.azure.com\`. The app refuses to save without it.
5. Leave **API version (optional)** empty to use the app's default, or enter a version such as \`2024-10-21\` if a feature you need requires it.
6. Paste a key into **API key / secret**.
7. Select **Connect & load models**. The list shows your deployments. Choose them in **Deployments to make available**, and select **Save**.

## Check it
Select **Test** on the card. A green message lists how many deployments the app found. Then send a short message from **Chat**.

## Good to know
- The model ID in this app is the **deployment name**, not the base model's name. If you rename a deployment in Azure, remove and re-add it here.
- If the list shows base-model names instead of your deployments, the app could not read your deployments. Type your deployment names into the list and press <kbd>Enter</kbd>.
- Quotas belong to each deployment. A busy deployment can return 429 errors even when the account is fine.
- Content filters set in Azure can block a reply. Users then see an error, so tell them to rephrase.

## If it fails
- **401 "Access denied":** the key belongs to a different resource, or someone rotated it.
- **404 "DeploymentNotFound":** the deployment name does not match. Check the spelling and the resource.
- **"API version not supported":** enter a newer version in **API version (optional)**.
- **Network errors:** if the resource allows only a private network, the app's server must run inside that network.` },

  { id: 'ai-lmstudio', title: 'LM Studio', ...ADMIN_AI, body: `
Run models on your own hardware with LM Studio. Prompts never leave your network, and the provider charges nothing per token.

## What you need
- A computer with enough memory for the model, running [LM Studio](https://lmstudio.ai).
- A model that supports tool calls, or the agent cannot use its tools. Look for the tool-use badge in LM Studio's model list.
- A network route from this app's server to that computer.

## Start the LM Studio server
1. In LM Studio, download a model.
2. Open the **Developer** tab and load the model. Set a **context length** you can afford, because larger windows use more memory.
3. Switch the local server to **Running**. By default it listens on port \`1234\`. To serve other computers, turn on the option to serve on the local network.

## Connect it
1. Go to **Admin**, then **Server (AI services)**, and select **Add connection**.
2. Set **Name** to something like \`LM Studio (office)\`.
3. Set **Type** to **LM Studio**.
4. Leave **Base URL** as \`http://localhost:1234/v1\` if LM Studio runs on the same machine as this app's server. Otherwise, enter that computer's address, such as \`http://192.168.1.20:1234/v1\`.
5. Leave **API key / secret** empty.
6. Select **Connect & load models**, choose your models, and select **Save**.

## Check it
Select **Test** on the card. A green message lists the models LM Studio reports. Then send a short message from **Chat**.

## Good to know
- This type accepts private and loopback addresses. Only Ollama and self-hosted servers share that ability.
- Open **Edit** on each model and set **Context window (tokens)** to the same length you loaded it with. Then the "session is getting long" hint appears at the right time.
- Local models are slower and weaker at long tasks than large cloud models. Set **Max reply (tokens)** with care, and use a cloud model for the Act default if results suffer.
- LM Studio serves one machine. For a team, consider [a self-hosted server](#ai-generic) built for many users.

## If it fails
- **"Connection refused":** the server is not running, or the address and port are wrong.
- **Works on your laptop, fails from the server:** \`localhost\` points at the app's server, not your laptop. Use the LM Studio computer's address.
- **The list is empty:** load a model in LM Studio first.
- **The agent talks but never uses tools:** the model lacks tool support. Choose another.` },

  { id: 'ai-ollama', title: 'Ollama', ...ADMIN_AI, body: `
Run open models on your own hardware with Ollama. Prompts never leave your network, and the provider charges nothing per token.

## What you need
- A computer with enough memory for the model, running [Ollama](https://ollama.com).
- A model that supports tools. Check the model's page in the Ollama library for a **tools** label.
- A network route from this app's server to that computer.

## Start Ollama and pull a model
1. Install Ollama and make sure it runs. Test with \`ollama list\`.
2. Pull a model:

\`\`\`bash
ollama pull qwen3
\`\`\`

3. Ollama listens on port \`11434\` and accepts connections from the same machine only. To let this app's server reach it from another computer, set \`OLLAMA_HOST=0.0.0.0\` before you start Ollama, and restrict access with your firewall.

## Connect it
1. Go to **Admin**, then **Server (AI services)**, and select **Add connection**.
2. Set **Name** to something like \`Ollama\`.
3. Set **Type** to **Ollama**.
4. Leave **Base URL** as \`http://localhost:11434/v1\` if Ollama runs on the same machine as this app's server. Otherwise, enter that computer's address, such as \`http://192.168.1.20:11434/v1\`. Keep the \`/v1\` at the end.
5. Leave **API key / secret** empty. Ollama needs none.
6. Select **Connect & load models**, choose your models, and select **Save**.

## Check it
Select **Test** on the card. A green message lists the models you pulled. Then send a short message from **Chat**.

## Good to know
- Ollama may load a model with a smaller context window than the model supports. Raise it in Ollama, for example with the \`OLLAMA_CONTEXT_LENGTH\` setting, then enter the same number under **Context window (tokens)** when you edit the model. Agent work needs a large window, so aim for at least 32,000 tokens.
- This type accepts private and loopback addresses. Only LM Studio and self-hosted servers share that ability.
- Ollama has no sign-in. Never expose its port to the internet.
- Add a model you pull later with **Add model ID** under the connection.

## If it fails
- **"Connection refused" or a timeout:** Ollama is not running, or it listens on the local machine only.
- **Works on your laptop, fails from the server:** \`localhost\` points at the app's server, not your laptop. Use the Ollama computer's address.
- **The list is empty:** run \`ollama pull\` for at least one model.
- **Replies cut off or the agent forgets things:** the context window is too small. Raise it in Ollama.` },

  { id: 'ai-generic', title: 'Self-hosted servers (OpenAPI-compatible)', ...ADMIN_AI, body: `
Connect any server that offers an OpenAI-style chat API, such as vLLM, llama.cpp, LocalAI, or LiteLLM. Pick this type for your own gateway too, as long as it speaks that API.

> [!INFO]
> The list calls this type "OpenAPI-compatible". It means compatible with the OpenAI chat-completions API. Use it for anything the other types do not cover.

## What you need
- A running server with an HTTP address the app's server can reach.
- The server's **base URL**, which usually ends in \`/v1\`.
- An API key, if the server requires one.
- A model that supports tool calls.

## Typical addresses
| Server | Typical base URL |
|---|---|
| vLLM | \`http://host:8000/v1\` |
| llama.cpp (\`llama-server\`) | \`http://host:8080/v1\` |
| LocalAI | \`http://host:8080/v1\` |
| LiteLLM proxy | \`http://host:4000/v1\` |

Your setup may use other ports. Check the server's own documentation.

## Connect it
1. Go to **Admin**, then **Server (AI services)**, and select **Add connection**.
2. Set **Name** to something like \`Company GPU server\`.
3. Set **Type** to **OpenAPI-compatible (self-hosted)**.
4. Enter your server's address in **Base URL**. The app requires it for this type.
5. Enter a key in **API key / secret** only if the server asks for one.
6. Select **Connect & load models**, choose your models, and select **Save**.

## Check it
Select **Test** on the card. A green message lists the models the server reports. Then send a short message from **Chat**.

## Good to know
- This type accepts private and loopback addresses. Only LM Studio and Ollama share that ability. That makes it the right type for an internal gateway in front of cloud models too.
- Use \`https://\` for any server that carries traffic across a network you do not control.
- Set **Context window (tokens)** on each model to what the server loaded. Servers such as vLLM take that value at startup.
- If the server lists no models, type the exact model name into **Add model ID**. The name must match what the server expects.

## If it fails
- **"generic_requires_base_url":** the **Base URL** field is empty.
- **404 on connect:** the base URL is missing \`/v1\`, or it has an extra path.
- **401:** the server needs a key. Enter it in **API key / secret**.
- **Tool calls fail:** the model or the server's chat template lacks tool support. Start the server with tool calling enabled, or choose another model.` },

  { id: 'ai-troubleshooting', title: 'Troubleshooting connections', ...ADMIN_AI, body: `
Start here when **Connect & load models** or **Test** fails. The message under the button names the cause.

## Read the message
| You see | Likely cause | Try |
|---|---|---|
| 401, "Unauthorized", "invalid key" | Wrong, expired, or revoked key | Create a new key and paste it again |
| 403, "Access denied", "Permission denied" | The key lacks a permission, or the model is not enabled | Check the role or policy. On Bedrock, request model access |
| 404, "not found" | Wrong base URL or deployment name | Compare the address with the provider's guide |
| 429, "quota", "rate limit" | No credit, or too many requests | Add credit, or ask the provider to raise the limit |
| "private address blocked" | A cloud type points at a private network address | Use **LM Studio**, **Ollama**, or **OpenAPI-compatible (self-hosted)** for private servers |
| "Re-enter the API key to query a changed endpoint" | You changed the address of a saved connection | Type the key again, so the app never sends the old key to a new host |
| Timed out after 20 seconds | The server cannot reach the provider, or the provider is slow | Check firewalls, proxies, and DNS on the app's server |
| An empty model list | No models loaded or pulled, or no access | Load a model, or type IDs into the list yourself |

## Work through it
1. Read the exact message. Do not guess.
2. Open the provider's guide and compare each field, character by character.
3. Check that the app's **server** can reach the address. A browser that reaches it proves nothing.
4. Replace the key. Keys are the most common cause.
5. Look in the **Audit log** for \`provider.discover\` entries to confirm your attempts reached the server.

## If users report problems
- **"No model available":** check that the connection has **Enabled** switched on, that **Restrict to roles (empty = all)** includes the user's role, and that you switched on at least one model under **Edit**.
- **Errors only in long sessions:** the context window is full. Check **Context window (tokens)** matches the real limit.
- **The agent never uses tools:** the model lacks tool support. Turn off **Subagents** for it, or pick another model.

> [!INFO]
> The app never shows a stored key. If you doubt it, enter a new one. The old key stays valid at the provider until you revoke it there.` },
];
