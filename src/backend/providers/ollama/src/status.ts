import { brokerFetch } from '../../network'
export async function status(context: any) {
  const baseUrl = context.baseUrl.replace(/\/$/, '')
  try {
    const [versionResponse, tagsResponse] = await Promise.all([
      brokerFetch(`${baseUrl}/api/version`),
      brokerFetch(`${baseUrl}/api/tags`)
    ])
    const version = versionResponse.ok ? await versionResponse.json() as any : null
    const tags = tagsResponse.ok ? await tagsResponse.json() as any : null
    const models = (tags?.models ?? []).map((model: any) => model.model ?? model.name).filter(Boolean)
    return { running: versionResponse.ok || tagsResponse.ok, version: version?.version, models, baseUrl: context.baseUrl }
  } catch {
    return { running: false, models: [], baseUrl: context.baseUrl }
  }
}
