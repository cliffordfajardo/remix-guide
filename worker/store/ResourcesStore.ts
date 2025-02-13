import { customAlphabet } from 'nanoid';
import { json } from 'remix';
import { matchCache, removeCache, updateCache } from '../cache';
import { createLogger } from '../logging';
import { getIntegrations, getIntegrationsFromPage } from '../scraping';
import type {
	Env,
	Page,
	Resource,
	ResourceSummary,
	ResourceMetadata,
	SubmissionStatus,
	AsyncReturnType,
} from '../types';
import { createStoreFetch, restoreStoreData } from '../utils';
import { getPageStore } from './PageStore';

/**
 * ID Generator based on nanoid
 * Using alphabets and digits only
 */
const generateId = customAlphabet(
	'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
	12,
);

async function createResourceStore(state: DurableObjectState, env: Env) {
	const { storage } = state;
	const { CONTENT } = env;
	const pageStore = getPageStore(env, state);

	const resourceIdByURL =
		(await storage.get<Record<string, string | undefined>>('index/URL')) ?? {};
	const resourceIdByPackageName =
		(await storage.get<Record<string, string | undefined>>(
			'index/PackageName',
		)) ?? {};

	async function createResource(
		page: Page,
		userId: string,
	): Promise<{
		id: string | null;
		status: SubmissionStatus;
	}> {
		const id = generateId();
		const now = new Date().toISOString();

		await updateResource(
			{
				id,
				url: page.url,
				createdAt: now,
				createdBy: userId,
				updatedAt: now,
				updatedBy: userId,
			},
			page,
		);

		if (page.category === 'package') {
			resourceIdByPackageName[page.title] = id;
			storage.put('index/PackageName', resourceIdByPackageName);
		}

		return {
			id,
			status: 'PUBLISHED',
		};
	}

	async function getResource(resourceId: string) {
		const resource = await storage.get<ResourceSummary>(resourceId);

		if (!resource) {
			return null;
		}

		return {
			id: resource.id,
			url: resource.url,
			createdAt: resource.createdAt,
			createdBy: resource.createdBy,
			updatedAt: resource.updatedAt,
			updatedBy: resource.updatedBy,
		};
	}

	async function updateResource(
		resource: ResourceSummary,
		page?: Page,
	): Promise<void> {
		await storage.put(resource.id, resource);
		await updateResourceCache(resource, page);
	}

	async function updateResourceCache(
		summary: ResourceSummary,
		pageData?: Page,
	): Promise<void> {
		const page = pageData ?? (await pageStore.getPage(summary.url));

		if (!page) {
			throw new Error('No page data found for the corresponding URL');
		}

		const packages = Object.keys(resourceIdByPackageName);
		const integrations =
			page.category === 'package' || page.category === 'repository'
				? getIntegrations(page.configs ?? [], packages, page.dependencies ?? {})
				: getIntegrationsFromPage(page, packages);
		const resource: Resource = {
			...summary,
			category: page.category,
			author: page.author,
			title: page.title,
			description: page.description,
			image: page.image,
			video: page.video,
			isSafe: page.isSafe,
			dependencies: page.dependencies,
			configs: page.configs,
			viewCount: page.viewCount,
			bookmarkUsers: page.bookmarkUsers,
			integrations,
		};
		const metadata: ResourceMetadata = {
			id: resource.id,
			url: resource.url,
			category: resource.category,
			author: resource.author,
			title: resource.title,
			description: resource.description?.slice(0, 80),
			viewCount: resource.viewCount ?? 0,
			bookmarkCount: resource.bookmarkUsers?.length ?? 0,
			integrations: resource.integrations,
			createdAt: resource.createdAt,
		};

		await CONTENT.put(`resources/${resource.id}`, JSON.stringify(resource), {
			metadata,
		});
	}

	return {
		async submit(userId: string, url: string) {
			let status: SubmissionStatus | null = null;
			let page = await pageStore.getOrCreatePage(url);

			if (!page.isSafe) {
				return {
					id: null,
					status: 'INVALID',
				};
			}

			let id = resourceIdByURL[page.url] ?? null;

			if (!id) {
				const result = await createResource(page, userId);

				id = result.id;
				status = result.status;

				if (id) {
					resourceIdByURL[page.url] = id;
					storage.put('index/URL', resourceIdByURL);
				}
			} else {
				status = 'RESUBMITTED';
			}

			return { id, status };
		},
		async refresh(resourceId: string) {
			let resource = await getResource(resourceId);

			if (!resource) {
				throw new Error(`Unknown resourceId found; Received ${resourceId}`);
			}

			// Only refresh the cache
			await updateResourceCache(resource);
		},
		async getDetails(resourceId: string | null) {
			const resource = resourceId ? await getResource(resourceId) : null;

			if (!resource) {
				return null;
			}

			updateResourceCache(resource);

			return resource;
		},
		async backup(): Promise<Record<string, any>> {
			const data = await storage.list();

			return Object.fromEntries(data);
		},
		async restore(data: Record<string, any>): Promise<void> {
			await restoreStoreData(storage, data);
		},
	};
}

export function getResourceStore(
	env: Env,
	ctx: ExecutionContext | DurableObjectState,
) {
	const fetchStore = createStoreFetch(env.RESOURCES_STORE, 'resources');
	const storeName = '';

	return {
		async listResources(): Promise<ResourceMetadata[]> {
			let list = await matchCache<ResourceMetadata[]>('resources');

			if (!list) {
				const result = await env.CONTENT.list<ResourceMetadata>({
					prefix: 'resources/',
				});

				list = result.keys.flatMap((key) => key.metadata ?? []);

				ctx.waitUntil(updateCache('resources', list, 300));
			}

			return list;
		},
		async query(resourceId: string) {
			let resource = await matchCache<Resource>(`resources/${resourceId}`);

			if (!resource) {
				resource = await env.CONTENT.get<Resource>(
					`resources/${resourceId}`,
					'json',
				);

				if (!resource) {
					resource = await fetchStore(storeName, '/details', 'GET', {
						resourceId,
					});
				}

				if (resource) {
					ctx.waitUntil(updateCache(`resources/${resourceId}`, resource, 300));
				}
			}

			return resource;
		},
		async submit(
			url: string,
			userId: string,
		): Promise<{ id: string; status: SubmissionStatus }> {
			const { id, status } = await fetchStore(storeName, '/submit', 'POST', {
				url,
				userId,
			});

			if (status === 'PUBLISHED') {
				ctx.waitUntil(removeCache('resources'));
			}

			return {
				id,
				status,
			};
		},
		async refresh(resourceId: string): Promise<void> {
			await fetchStore(storeName, '/refresh', 'POST', { resourceId });
			ctx.waitUntil(removeCache(`resources/${resourceId}`));
		},
		async backup(): Promise<Record<string, any>> {
			return await fetchStore(storeName, '/backup', 'POST');
		},
		async restore(data: Record<string, any>): Promise<void> {
			return await fetchStore(storeName, '/restore', 'POST', data);
		},
	};
}

/**
 * ResourcesStore - A durable object that keeps resources data and preview info
 */
export class ResourcesStore {
	env: Env;
	state: DurableObjectState;
	store: AsyncReturnType<typeof createResourceStore> | null;

	constructor(state: DurableObjectState, env: Env) {
		this.env = env;
		this.state = state;
		this.store = null;
		state.blockConcurrencyWhile(async () => {
			this.store = await createResourceStore(state, env);
		});
	}

	async fetch(request: Request) {
		const logger = createLogger(request, {
			...this.env,
			LOGGER_NAME: 'store:ResourcesStore',
		});

		let response = new Response('Not found', { status: 404 });

		try {
			let url = new URL(request.url);
			let method = request.method.toUpperCase();

			if (!this.store) {
				throw new Error(
					'The store object is unavailable; Please check if the store is initialised properly',
				);
			} else if (url.pathname === '/submit' && method === 'POST') {
				const { url, userId } = await request.json();
				const result = await this.store.submit(userId, url);

				response = json(result, 201);
			} else if (url.pathname === '/refresh' && method === 'POST') {
				const { resourceId } = await request.json();

				await this.store.refresh(resourceId);

				response = new Response(null, { status: 204 });
			} else if (url.pathname === '/details' && method === 'GET') {
				const resourceId = url.searchParams.get('resourceId');
				const resource = await this.store.getDetails(resourceId);

				if (resource) {
					response = json(resource);
				}
			} else if (url.pathname === '/backup' && method === 'POST') {
				const data = await this.store.backup();

				response = json(data);
			} else if (url.pathname === '/restore' && method === 'POST') {
				const data = await request.json<any>();

				await this.store.restore(data);

				// Re-initialise everything again
				this.store = await createResourceStore(this.state, this.env);

				response = new Response(null, { status: 204 });
			}
		} catch (e) {
			console.log('error', e);
			if (e instanceof Error) {
				logger.error(e);
				logger.log(
					`ResourcesStore failed while handling fetch - ${request.url}; Received message: ${e.message}`,
				);
			}

			response = new Response('Internal Server Error', { status: 500 });
		} finally {
			logger.report(response);
		}

		return response;
	}
}
