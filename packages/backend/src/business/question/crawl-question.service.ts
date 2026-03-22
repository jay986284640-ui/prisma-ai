import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { UserInfoFromToken } from '@prisma-ai/shared';
import * as fs from 'fs';
import * as path from 'path';
import * as puppeteer from 'puppeteer';
import { ChainService } from '../../chain/chain.service';
import { DbService } from '../../DB/db.service';
import { TaskQueueService } from '../../task-queue/task-queue.service';
import { PersistentTask } from '../../type/taskqueue';
import { StartCrawlQuestionDto } from './dto/start-crawl-question.dto';

/**
 * 爬取到的原始文章数据接口
 */
interface CrawledArticle {
	link: string;
	content_type: string;
	title: string;
	quiz_type: string;
	content: string;
	gist: string;
	hard: string;
	time_create: Date;
	time_update: Date;
}

interface CrawlTask extends PersistentTask {
	metadata: {
		options: StartCrawlQuestionDto & {
			userId: number;
			userInfo: UserInfoFromToken;
		};
		progress: {
			totalCount: number;
			completedCount: number;
		};
	};
}
//延迟伪装配置
const delayConfig = {
	//列表页延迟
	list: {
		minDelay: 0,
		maxDelay: 1000
	},
	//详情页延迟
	detail: {
		minDelay: 0,
		maxDelay: 500
	},
	//滚动延迟
	scroll: {
		minDelay: 0,
		maxDelay: 500
	}
};

/**
 * 爬取面试题的爬虫
 * 爬虫功能：
 * 1. 爬取指定网站的面试题页面HTML
 * 2. 使用LLM从HTML中提取结构化数据
 * 3. 将数据存入数据库
 * 爬虫伪装：
 * 1. 设置访问频率伪装
 * 2. 使用正态分布的随机延迟，模拟真实用户行为
 * 3. 模拟真实用户行为(滚动、鼠标移动)
 */
@Injectable()
export class CrawlQuestionService implements OnModuleDestroy {
	// 日志记录器
	private readonly logger = new Logger(CrawlQuestionService.name);
	taskType = 'crawl-question';
	// 用于HTML转Markdown的浏览器实例和页面
	private browser: puppeteer.Browser | null = null;
	private converterPage: puppeteer.Page | null = null;
	// 标记是否正在处理断开连接，避免重复处理
	private isDisconnecting = false;
	// 本地缓存文件路径，用于中断恢复
	private readonly cacheFilePath = path.join(process.cwd(), 'crawl_data/questions.json');

	constructor(
		private readonly taskQueueService: TaskQueueService,
		private readonly chainService: ChainService,
		private readonly dbService: DbService
	) {
		console.log('process.cwd():', process.cwd());
		try {
			this.taskQueueService.registerTaskHandler(this.taskType, this._taskHandler.bind(this));
		} catch (error) {
			this.logger.error(`爬虫任务处理器${this.taskType}注册失败: ${error}`);
			throw error;
		}
		this.logger.log(`爬虫任务处理器已注册: ${this.taskType}`);
	}

	async onModuleDestroy() {
		this.logger.log('正在关闭浏览器实例...');
		if (this.browser) {
			await this.browser.close();
			this.browser = null;
			this.converterPage = null;
			this.logger.log('浏览器实例已关闭。');
		}
	}

	private async _taskHandler(task: CrawlTask): Promise<void> {
		await this._startSpider(task);
	}

	/**
	 * 启动爬虫任务
	 */
	async startCrawl(
		options: StartCrawlQuestionDto & { userId: string; userInfo: UserInfoFromToken }
	) {
		const sessionId = crypto.randomUUID();
		const task = await this.taskQueueService.createAndEnqueueTask(
			sessionId,
			options.userId.toString(),
			this.taskType,
			{ options, progress: { totalCount: -1, completedCount: 0 } }
		);
		this.logger.log(`已创建并入队爬虫任务: ${task.id}`);
		return task;
	}

	/**
	 * 主入口：启动爬虫，并根据提供的参数抓取职位信息
	 * @param task 爬虫任务
	 */
	private async _startSpider(task: CrawlTask) {
		const listPageUrl = task.metadata.options.list;
		const domain = task.metadata.options.domain;

		this.logger.log(`开始爬取目标URL: ${listPageUrl}`);

		// 统一初始化浏览器和页面
		this.browser = await this._initializeBrowser();

		// 先获取已有页面的 cookies（保持登录状态）
		const existingPages = await this.browser.pages();
		const cookies: puppeteer.CookieParam[] = [];
		if (existingPages.length > 0) {
			try {
				const existingCookies = await existingPages[0].cookies();
				cookies.push(...existingCookies);
				this.logger.log(`从已有页面获取到 ${cookies.length} 个 cookies`);
			} catch (e) {
				this.logger.warn('获取 cookies 失败');
			}
		}

		// 创建新页面并设置 cookies
		const page = await this.browser.newPage();
		if (cookies.length > 0) {
			this.logger.log(`获取到的 cookies: ${JSON.stringify(cookies.map(c => ({ name: c.name, domain: c.domain, path: c.path })))}`);
			await page.setCookie(...cookies);
			this.logger.log(`已为新页面设置 ${cookies.length} 个 cookies`);
			// 先访问列表页让 session 初始化
			await page.goto('https://java.mid-life.vip/topic-list', { waitUntil: 'networkidle2' });
			this.logger.log('已访问列表页初始化 session');
		} else {
			this.logger.warn('没有获取到 cookies，新页面可能未登录');
		}

		// converterPage 仍然需要是新页面
		this.converterPage = await this.browser.newPage();

		// 尝试访问 htmlmarkdown.com，增强重试机制
		try {
			await this.converterPage.goto('https://htmlmarkdown.com/', {
				waitUntil: 'networkidle2',
				timeout: 30000
			});
		} catch (e) {
			this.logger.warn(`无法访问htmlmarkdown.com: ${e.message}，将使用简单文本提取`);
			// 不再直接抛出错误，允许继续执行（后续转换会使用简单方法）
			this.converterPage = null;
		}

		try {
			// 1. 高效获取所有需要处理的URL
			const categoriesWithUrls = await this._getQuestionCategoriesAndUrls(
				page,
				listPageUrl,
				domain,
				task
			);
			let totalLinks = 0;
			categoriesWithUrls.forEach(links => (totalLinks += links.length));
			this.logger.log(`成功收集到 ${categoriesWithUrls.size} 个分类，共 ${totalLinks} 个题目链接`);

			// 2. 准备缓存数据
			const cachedData = this._readCache();
			const cachedArticlesMap = new Map<string, CrawledArticle>();
			Object.values(cachedData)
				.flat()
				.forEach(article => {
					cachedArticlesMap.set(article.link, article);
				});
			this.logger.log(`已从缓存加载 ${cachedArticlesMap.size} 条题目详情。`);

			// 3. 遍历链接，结合缓存抓取、处理并保存
			const articlesToSave: CrawledArticle[] = [];
			for (const [category, urls] of categoriesWithUrls.entries()) {
				this.logger.log(`开始处理分类: ${category}, 共 ${urls.length} 个题目`);

				const newArticlesForCategory: CrawledArticle[] = [];
				for (const url of urls) {
					// 检查浏览器连接状态，必要时重新初始化
					await this._ensureBrowserConnected(page);

					// 过滤：如果详情已在缓存中，直接使用
					if (cachedArticlesMap.has(url)) {
						articlesToSave.push(cachedArticlesMap.get(url)!);
						continue;
					}

					// 抓取包含原始HTML的数据
					let rawData = await this._getQuestionDetails(page, url, category);
					let retryCount = 0;
					while (!rawData?.titleHtml || !rawData?.contentHtml) {
						// 检查是否是浏览器断开导致的错误，尝试重连
						if (retryCount > 0 && retryCount % 2 === 0) {
							this.logger.warn('检测到可能的浏览器断开，正在尝试重新连接...');
							await this._ensureBrowserConnected(page);
						}
						if (retryCount > 5) {
							this.logger.warn(`重试5次后仍未能从 ${url} 提取到标题/内容, 跳过...`);
							this.logger.debug(rawData);
							throw new Error(`重试5次后仍未能从 ${url} 提取到标题/内容`);
						}
						this.logger.warn(`未能从 ${url} 提取到标题/内容, 重试...`);
						rawData = await this._getQuestionDetails(page, url, category);
						retryCount++;
					}
					if (rawData) {
						// 转换Markdown并组合成最终数据
						const title = await this._htmlToMarkdown(rawData.titleHtml);
						const content = await this._htmlToMarkdown(rawData.contentHtml);
						const gist = await this._htmlToMarkdown(rawData.gistHtml);

						// 剔除临时的 html 字段
						const { titleHtml, contentHtml, gistHtml, ...rest } = rawData;

						const newArticle: CrawledArticle = {
							...rest,
							title,
							content,
							gist
						};
						articlesToSave.push(newArticle);
						newArticlesForCategory.push(newArticle);
					}
				}

				// 如果这是一个新抓取的分类，则将其数据写入缓存
				const normalizedCategory = this._normalizeCategory(category);
				if (newArticlesForCategory.length > 0 && !cachedData[normalizedCategory]) {
					cachedData[normalizedCategory] = newArticlesForCategory;
					this._writeCache(cachedData);
					this.logger.log(
						`新分类 "${category}" 的 ${newArticlesForCategory.length} 条题目数据已抓取并缓存。`
					);
				}
			}

			// 分批净化并存储,一批350条（尽量吃满一个批次的llm生成任务并发）
			const batchSize = 350;
			for (let i = 0; i < articlesToSave.length; i += batchSize) {
				const batch = articlesToSave.slice(i, i + batchSize);
				//批量净化markdown内容
				const normalizedArticles = await this._markdownNormalize(
					batch,
					task.metadata.options.userInfo
				);
				//批量保存到数据库
				await this._saveArticles(normalizedArticles, task);
			}

			// 删除本地缓存
			this._deleteCache();
			return { message: '爬虫任务完成' };
		} catch (error) {
			this.logger.error('爬虫执行过程中发生错误:', error);
			throw error;
		} finally {
			// 在任务结束时不关闭浏览器，由 onModuleDestroy 管理
			if (page && !page.isClosed()) await page.close();
			if (this.converterPage && !this.converterPage.isClosed()) {
				await this.converterPage.close();
			}
			this.logger.log('任务页面已关闭，但浏览器实例保持运行。');
		}
	}

	/**
	 * 抓取单个题目的详细页html内容
	 * @param page Puppeteer页面对象
	 * @param url 题目URL
	 * @param category 题目分类
	 * @returns 题目详情页html内容
	 */
	private async _getQuestionDetails(
		page: puppeteer.Page,
		url: string,
		category: string
	): Promise<
		| (Omit<CrawledArticle, 'title' | 'content' | 'gist'> & {
				titleHtml: string;
				contentHtml: string;
				gistHtml: string;
		  })
		| null
	> {
		try {
			// 检查页面是否有效
			if (!page || page.isClosed()) {
				this.logger.warn(`页面已关闭，无法抓取: ${url}`);
				return null;
			}

			this.logger.log(`开始抓取题目: ${url}`);

			await this._simulateHumanBehavior('detail');
			await page.goto(url, { waitUntil: 'networkidle2' });

			// 打印页面标题和 URL
			const pageInfo = await page.evaluate(() => {
				return {
					title: document.title,
					url: window.location.href,
					bodyText: document.body?.innerText?.substring(0, 200) || '',
					hasContent: document.querySelector('.detailBox___3lvLy') !== null,
					hasLoginMsg: document.body?.innerText?.includes('登录后可看答案'),
				};
			});
			this.logger.log(`页面信息: title=${pageInfo.title}, url=${pageInfo.url}`);
			this.logger.log(`页面内容: ${pageInfo.bodyText.replace(/\n/g, ' ')}`);
			this.logger.log(`是否有详情内容: ${pageInfo.hasContent}, 是否显示登录: ${pageInfo.hasLoginMsg}`);

			// 立即检查是否是 VIP 无权限页面，避免等待超时
			try {
				await page.waitForSelector('.ant-result-title', { timeout: 3000 });
				const resultTitle = await page.$eval('.ant-result-title', el => el.textContent);
				if (resultTitle && resultTitle.includes('没有权限查看会员题库的答案')) {
					this.logger.warn(`题目 ${url} 需要 VIP 权限，跳过`);
					return null;
				}
			} catch (e) {
				// 没有找到 .ant-result-title，说明页面正常，继续执行
			}

			// 等待按钮出现，但先尝试滚动到按钮位置确保可见
			try {
				const btnCheck = await page.evaluate(() => {
					const btn = document.querySelector('.answerBtn___3rwds');
					if (btn instanceof HTMLElement) {
						btn.scrollIntoView({ behavior: 'instant', block: 'center' });
						return {
							exists: true,
							visible: btn.offsetParent !== null,
							display: window.getComputedStyle(btn).display,
							rect: btn.getBoundingClientRect()
						};
					}
					return { exists: false };
				});
				this.logger.log(`答案按钮检查: ${JSON.stringify(btnCheck)}`);
				// 等待一小段时间让滚动完成
				await new Promise(resolve => setTimeout(resolve, 500));
			} catch (e) {
				this.logger.warn('滚动到答案按钮位置失败');
			}

			// 按钮已确认存在，直接点击
			await this._simulateUserInteraction(page);

			// 更真实的点击模拟
			const success = await this._realUserClick(page, '.answerBtn___3rwds');
			if (!success) {
				this.logger.warn(`无法点击查看答案按钮: ${url}`);
				return null;
			}

			// 等待答案内容加载
			await this._waitForSelectorWithKeepAlive(page, '.detailBox___3lvLy', { timeout: 100000 });

			// 再次模拟用户交互，确保页面内容完全加载
			await this._simulateUserInteraction(page);

			const extractedData = await page.evaluate(() => {
				const getText = (selector: string) =>
					document.querySelector(selector)?.textContent?.trim() || '';

				// 提取标题和问题类型
				const titleEl = document.querySelector('h2.title___3qmX3');
				const quiz_type = titleEl?.querySelector('span.ant-tag')?.textContent?.trim() || '问答题';
				const titleText = titleEl?.querySelector('span:last-of-type')?.textContent?.trim() || '';

				if (!titleText) {
					return null;
				}
				// 扩展标题内容，包含代码和选项
				const descBox = document.querySelector('div.descBox___DeQQJ');
				const choiceBox = document.querySelector('div.choiceBox___2cy4E');

				let titleHtml = `<div><span>${titleText}</span>`;
				if (descBox) {
					titleHtml += descBox.outerHTML;
				}
				if (choiceBox) {
					titleHtml += choiceBox.outerHTML;
				}
				titleHtml += '</div>';

				// 提取难度
				const fullStars = document.querySelectorAll(
					'div.secondBox___2B0S4 ul li.ant-rate-star-full'
				).length;
				const halfStars = document.querySelectorAll(
					'div.secondBox___2B0S4 ul li.ant-rate-star-half'
				).length;
				const hard = String(fullStars + halfStars * 0.5);

				// 提取时间
				const createText = getText('div.secondBox___2B0S4 span');
				const updateText = getText('.ant-tabs-tabpane-active p[style*="text-align: right"]');

				// 点击 "题目要点" tab 以确保其内容在DOM中可见
				const keyPointsTab = document.querySelector(
					'.ant-tabs-nav-list .ant-tabs-tab:nth-child(2)'
				) as HTMLElement;
				if (keyPointsTab) {
					keyPointsTab.click();
				}

				// 提取答案和要点的原始HTML
				let contentHtml = '';
				let gistHtml = '';
				const answerTitles = document.querySelectorAll('p.answerTitle___1T-fK');
				answerTitles.forEach(p => {
					if (p.textContent?.includes('参考答案')) {
						const parentDiv = p.parentElement;
						contentHtml = `<div>
						${parentDiv?.nextElementSibling?.outerHTML}
						${parentDiv?.nextElementSibling?.nextElementSibling?.outerHTML}
						</div>`;
					} else if (p.textContent?.includes('题目要点')) {
						const markdownBody = p.nextElementSibling;
						if (markdownBody?.classList.contains('markdown-body')) {
							gistHtml = markdownBody.outerHTML;
						}
					}
				});

				return { titleHtml, quiz_type, hard, createText, updateText, contentHtml, gistHtml };
			});

			if (!extractedData) {
				this.logger.warn(`未能从 ${url} 提取到标题`);
				return null;
			}

			const time_create_match = extractedData.createText.match(/(\d{4}-\d{2}-\d{2})/);
			const time_create = time_create_match ? new Date(time_create_match[0]) : new Date();

			const time_update_match = extractedData.updateText.match(/(\d{4}-\d{2}-\d{2})/);
			const time_update = time_update_match
				? new Date(time_update_match[0])
				: new Date(time_create);

			// 提取标题文本用于日志
			const titleMatch = extractedData.titleHtml.match(/<span>([^<]+)<\/span>/);
			const titlePreview = titleMatch ? titleMatch[1].substring(0, 30) : '未知标题';
			const hasAnswer = extractedData.contentHtml.length > 0;
			const hasGist = extractedData.gistHtml.length > 0;
			this.logger.log(`题目抓取成功: ${titlePreview}... | 答案:${hasAnswer ? '有' : '无'} | 要点:${hasGist ? '有' : '无'}`);

			return {
				link: this._normalizeUrl(url),
				content_type: this._normalizeCategory(category),
				quiz_type: extractedData.quiz_type,
				hard: extractedData.hard,
				time_create,
				time_update,
				titleHtml: extractedData.titleHtml,
				contentHtml: extractedData.contentHtml,
				gistHtml: extractedData.gistHtml
			};
		} catch (error) {
			// 检查是否是 TargetCloseError（目标页面已关闭）
			if (error instanceof Error && error.name === 'TargetCloseError') {
				this.logger.warn(`页面连接已关闭，可能是浏览器超时或断开: ${url}`);
			} else {
				this.logger.error(`抓取题目详情失败: ${url}`, error.stack);
			}
			return null;
		}
	}
	/**
	 * 初始化 Puppeteer 浏览器和页面实例
	 * @returns 返回浏览器实例
	 */
	private async _initializeBrowser(): Promise<puppeteer.Browser> {
		if (this.browser && this.browser.isConnected()) {
			this.logger.log('浏览器实例已存在，将重用。');
			return this.browser;
		}

		this.logger.log('正在初始化浏览器...');
		const browserWSEndpoint = process.env.PUPPETEER_BROWSER_WSE_ENDPOINT;

		if (browserWSEndpoint) {
			this.logger.log(`正在连接到远程浏览器: ${browserWSEndpoint}`);
			try {
				this.browser = await puppeteer.connect({
					browserWSEndpoint,
					defaultViewport: {
						width: 1366,
						height: 768
					},
					// 增加协议超时时间到 5 分钟
					protocolTimeout: 300000
				});
				this.logger.log('成功连接到远程浏览器。');
			} catch (error) {
				this.logger.error(`连接到远程浏览器失败: ${error.message}`, error.stack);
				throw new Error('无法连接到远程浏览器服务');
			}
		} else {
			this.logger.log('未检测到远程浏览器端点，将启动本地 Puppeteer 实例。');
			this.browser = await puppeteer.launch({
				headless: true,
				defaultViewport: {
					width: 1366,
					height: 768
				},
				// 增加协议超时时间到 5 分钟
				protocolTimeout: 300000,
				args: [
					'--no-sandbox',
					'--disable-setuid-sandbox',
					'--disable-dev-shm-usage',
					'--disable-web-security',
					'--disable-features=VizDisplayCompositor',
					'--disable-blink-features=AutomationControlled'
				]
			});
			this.logger.log('本地 Puppeteer 实例启动成功。');
		}

		this.browser.on('disconnected', () => {
			if (this.isDisconnecting) return;
			this.isDisconnecting = true;
			this.logger.warn('浏览器连接已断开。');
			this.browser = null;
			this.converterPage = null;
			this.isDisconnecting = false;
		});

		return this.browser;
	}

	/**
	 * 从列表页收集所有职位详情页的链接
	 * @param page - Puppeteer 页面对象
	 * @param listPageUrl - 职位列表页的 URL
	 * @returns 职位详情页链接数组
	 */
	private async _getQuestionCategoriesAndUrls(
		page: puppeteer.Page,
		listPageUrl: string,
		domain: string,
		task: CrawlTask
	): Promise<Map<string, string[]>> {
		this.logger.log(`正在访问题目列表页: ${listPageUrl}`);
		await this._simulateHumanBehavior('list');
		await page.goto(listPageUrl, { waitUntil: 'networkidle2' });

		// 等待标签加载
		await page.waitForSelector('.entryBox___1cUts span.ant-tag-checkable', { timeout: 100000 });
		const allCategories = await page.evaluate(() =>
			Array.from(document.querySelectorAll('.entryBox___1cUts span.ant-tag-checkable'))
				.map(tag => tag.textContent || '')
				.filter(text => !text.includes('全部') && text)
		);
		this.logger.log(`网页上获取到以下所有分类: ${allCategories.join(', ')}`);

		// 1. 读取本地缓存，决定哪些分类需要新抓取URL
		const cachedData = this._readCache();
		const cachedCategories = Object.keys(cachedData);
		this.logger.log(`缓存中已存在分类: ${cachedCategories.join(', ')}`);

		const categoriesToCrawl = allCategories.filter(
			c => !cachedCategories.includes(this._normalizeCategory(c))
		);
		this.logger.log(`需要抓取URL的新分类: ${categoriesToCrawl.join(', ')}`);

		// 2. 整合所有需要的URL（从缓存和新抓取中）
		let urlToCategoryMap = new Map<string, string>();

		// 2a. 从缓存加载URL
		for (const category in cachedData) {
			cachedData[category].forEach(article => {
				urlToCategoryMap.set(article.link, category);
			});
		}

		// 2b. 抓取未缓存分类的URL
		for (const category of categoriesToCrawl) {
			this.logger.log(`正在为新分类抓取URL: ${category}`);

			// 点击当前分类标签
			await page.evaluate(cat => {
				const tags = Array.from(
					document.querySelectorAll('.entryBox___1cUts span.ant-tag-checkable')
				);
				const categoryTag = tags.find(tag => tag.textContent?.startsWith(cat));
				if (categoryTag) (categoryTag as HTMLElement).click();
			}, category);

			// 等待题目列表刷新
			await page.waitForSelector('.ant-list-items', { timeout: 100000 });
			await this._simulateHumanBehavior('list');

			let isLastPage = false;
			while (!isLastPage) {
				// 定期保活，防止 browserless 超时断开连接
				if (this.browser && this.browser.isConnected()) {
					try {
						await page.evaluate(() => 1); // 简单的 CDP ping
					} catch (e) {
						this.logger.warn('CDP ping 失败，尝试重新连接...');
						this.browser = await this._initializeBrowser();
					}
				}

				const urlsOnPageRaw = await page.evaluate(
					domain => {
						const links = Array.from(document.querySelectorAll('.ant-list-items div a[href]'));
						return links.map(a => {
							const href = a.getAttribute('href') || '';
							return { href, domain };
						});
					},
					domain
				);
				this.logger.log(`收集到的URL详情: ${JSON.stringify(urlsOnPageRaw.slice(0, 3))}`);

				const urlsOnPage = urlsOnPageRaw.map((item: { href: string; domain: string }) => {
					let href = item.href;
					if (href.startsWith('//')) {
						href = href.substring(1);
					}
					// 去掉 domain 尾部的斜杠，避免拼接时出现双斜杠
					const domain = item.domain.replace(/\/$/, '');
					return `${domain}${href}`;
				});

				for (const url of urlsOnPage) {
					const normalizedUrl = this._normalizeUrl(url);
					this.logger.log(`收集到URL: raw=${url}, normalized=${normalizedUrl}`);
					if (!urlToCategoryMap.has(normalizedUrl)) {
						urlToCategoryMap.set(normalizedUrl, this._normalizeCategory(category));
					}
				}

				if (isLastPage) break;

				const nextButton = await page.$('li.ant-pagination-next:not(.ant-pagination-disabled)');
				if (nextButton) {
					this.logger.log('点击下一页');
					try {
						await nextButton.click();
					} catch (e) {
						// 点击超时，尝试使用 JavaScript 点击
						this.logger.warn('按钮点击超时，尝试使用 JS 点击');
						await page.evaluate(() => {
							const btn = document.querySelector('li.ant-pagination-next:not(.ant-pagination-disabled)');
							if (btn instanceof HTMLElement) btn.click();
						});
					}
					await this._simulateHumanBehavior('list');
					// 使用带保活的 waitForSelector，防止 browserless 超时断开
					try {
						await this._waitForSelectorWithKeepAlive(page, '.ant-spin-spinning', { hidden: true, timeout: 100000 });
					} catch (e) {
						this.logger.warn('等待 loading spinner 消失超时，继续执行');
					}
				} else {
					this.logger.log(`分类 "${category}" 已是最后一页`);
					isLastPage = true;
				}
			}
		}

		//去掉数据库中已有的题目
		const existingArticles = await this.dbService.article.findMany({
			where: { link: { in: Array.from(urlToCategoryMap.keys()) } },
			select: { link: true }
		});
		const existingLinks = new Set(existingArticles.map(a => a.link));
		urlToCategoryMap = new Map(
			Array.from(urlToCategoryMap).filter(([url]) => !existingLinks.has(url))
		);

		this.logger.log(`过滤后，有 ${urlToCategoryMap.size} 个链接需要抓取。`);

		await this._updateTaskProgress(task, {
			totalCount: urlToCategoryMap.size,
			completedCount: 0
		});

		// 3. 将扁平的Map重构为 { 分类 -> 链接数组 } 的格式
		const categoriesWithUrls = new Map<string, string[]>();
		for (const [url, category] of urlToCategoryMap.entries()) {
			if (!categoriesWithUrls.has(category)) {
				categoriesWithUrls.set(category, []);
			}
			categoriesWithUrls.get(category)?.push(url);
		}

		return categoriesWithUrls;
	}

	/**
	 * 读取本地缓存的JSON文件
	 */
	private _readCache(): Record<string, CrawledArticle[]> {
		try {
			//cacheFilePath不存在则创建
			if (!fs.existsSync(this.cacheFilePath)) {
				fs.mkdirSync(path.dirname(this.cacheFilePath), { recursive: true });
				fs.writeFileSync(this.cacheFilePath, '{}');
			}
			const data = fs.readFileSync(this.cacheFilePath, 'utf-8');
			return data ? JSON.parse(data) : {};
		} catch (error) {
			this.logger.error('读取缓存文件失败', error);
			return {};
		}
	}

	/**
	 * 将数据写入本地缓存的JSON文件
	 * @param data 要写入的数据
	 */
	private _writeCache(data: Record<string, CrawledArticle[]>): void {
		try {
			fs.writeFileSync(this.cacheFilePath, JSON.stringify(data, null, 2), 'utf-8');
		} catch (error) {
			this.logger.error('写入缓存文件失败', error);
		}
	}

	/**
	 * 删除本地缓存的JSON文件
	 */
	private _deleteCache(): void {
		try {
			fs.unlinkSync(this.cacheFilePath);
		} catch (error) {
			this.logger.error('删除缓存文件失败', error);
		}
	}

	/**
	 * 更新任务进度
	 */
	private async _updateTaskProgress(
		task: CrawlTask,
		progress: { totalCount: number; completedCount: number }
	): Promise<void> {
		// 4. 更新任务进度
		const curTask = await this.taskQueueService.getTask<CrawlTask>(task.id);
		if (!curTask) return;
		const newTask: CrawlTask = {
			...curTask,
			metadata: {
				...curTask.metadata,
				progress
			}
		};
		await this.taskQueueService.saveTask(newTask);
	}

	/**
	 * 获取任务进度
	 */
	async getTaskProgress(task: CrawlTask): Promise<{ totalCount: number; completedCount: number }> {
		const curTask = await this.taskQueueService.getTask<CrawlTask>(task.id);
		if (!curTask) return { totalCount: -1, completedCount: 0 };
		return curTask.metadata.progress;
	}

	/**
	 * 使用外部网站将HTML转为markdown
	 * @param html 题目详情页的HTML
	 */
	private async _htmlToMarkdown(html: string): Promise<string> {
		if (!html) return '';

		// 尝试使用 converterPage 转换
		try {
			// 确保 converterPage 可用，必要时重新创建
			await this._ensureConverterPage();
		} catch (error) {
			this.logger.warn('无法获取有效的 converterPage，使用简单文本提取');
			return this._simpleHtmlToText(html);
		}

		if (!this.converterPage || this.converterPage.isClosed()) {
			this.logger.warn('converterPage 已关闭，使用简单文本提取');
			return this._simpleHtmlToText(html);
		}

		try {
			// 步骤1：在每次转换前，先清空输出区域，确保不会读取到上一次的陈旧数据
			await this.converterPage.evaluate(() => {
				const outputArea = document.getElementById('output') as HTMLTextAreaElement;
				if (outputArea) {
					outputArea.value = '';
				}
			});

			// 步骤2：注入新的HTML并触发转换
			await this.converterPage.evaluateHandle(h => {
				const inputArea = document.getElementById('input') as HTMLTextAreaElement;
				if (inputArea) {
					inputArea.value = h;
					inputArea.dispatchEvent(new Event('input', { bubbles: true }));
				}
			}, html);

			// 步骤3：等待输出区域出现新内容。因为我们已经清空了它，所以任何非空值都意味着转换已完成。
			await this.converterPage.waitForFunction(
				() => {
					const outputArea = document.getElementById('output') as HTMLTextAreaElement;
					return outputArea?.value;
				},
				{ timeout: 50000 }
			);

			const markdown = await this.converterPage.evaluate(() => {
				const outputArea = document.getElementById('output') as HTMLTextAreaElement;
				return outputArea.value;
			});

			return markdown;
		} catch (error) {
			this.logger.warn('HTML到Markdown转换失败或超时，返回空字符串');
			// 重置 converterPage 以便下次使用
			this.converterPage = null;
			return '';
		}
	}

	/**
	 * 确保 converterPage 可用，必要时重新创建
	 */
	private async _ensureConverterPage(): Promise<void> {
		if (this.converterPage && !this.converterPage.isClosed() && this.browser && this.browser.isConnected()) {
			return;
		}

		this.logger.log('正在重新创建 converterPage...');

		// 关闭旧页面（如果存在）
		if (this.converterPage && !this.converterPage.isClosed()) {
			try {
				await this.converterPage.close();
			} catch (e) {
				// 忽略关闭错误
			}
		}

		// 确保浏览器可用
		if (!this.browser || !this.browser.isConnected()) {
			this.logger.log('浏览器连接已断开，正在重新连接...');
			this.browser = await this._initializeBrowser();
		}

		// 创建新页面
		this.converterPage = await this.browser.newPage();

		// 重新访问转换网站
		try {
			await this.converterPage.goto('https://htmlmarkdown.com/', { waitUntil: 'networkidle2' });
		} catch (e) {
			this.logger.error('无法访问 htmlmarkdown.com，请检查网络或网站状态');
			throw e;
		}
	}

	/**
	 * 简单的HTML转文本方法（备用方案）
	 * @param html HTML内容
	 */
	private _simpleHtmlToText(html: string): string {
		if (!html) return '';

		// 移除script和style标签
		let text = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
		text = text.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

		// 替换常见的HTML标签为markdown格式
		text = text.replace(/<br\s*\/?>/gi, '\n');
		text = text.replace(/<\/p>/gi, '\n\n');
		text = text.replace(/<\/div>/gi, '\n');
		text = text.replace(/<\/li>/gi, '\n');

		// 处理代码块
		text = text.replace(/<pre[^>]*><code[^>]*>/gi, '```\n');
		text = text.replace(/<\/code><\/pre>/gi, '\n```');

		// 处理行内代码
		text = text.replace(/<code[^>]*>/gi, '`');
		text = text.replace(/<\/code>/gi, '`');

		// 处理加粗和斜体
		text = text.replace(/<strong[^>]*>/gi, '**');
		text = text.replace(/<\/strong>/gi, '**');
		text = text.replace(/<b[^>]*>/gi, '**');
		text = text.replace(/<\/b>/gi, '**');
		text = text.replace(/<em[^>]*>/gi, '*');
		text = text.replace(/<\/em>/gi, '*');
		text = text.replace(/<i[^>]*>/gi, '*');
		text = text.replace(/<\/i>/gi, '*');

		// 处理链接
		text = text.replace(/<a[^>]*href=["']([^"']*)["'][^>]*>([^<]*)<\/a>/gi, '[$2]($1)');

		// 处理图片
		text = text.replace(/<img[^>]*src=["']([^"']*)["'][^>]*alt=["']([^"']*)["'][^>]*\/?>/gi, '![$2]($1)');
		text = text.replace(/<img[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']*)["'][^>]*\/?>/gi, '![$1]($2)');
		text = text.replace(/<img[^>]*src=["']([^"']*)["'][^>]*\/?>/gi, '![]($1)');

		// 移除所有其他HTML标签
		text = text.replace(/<[^>]+>/g, '');

		// 解码HTML实体
		text = text.replace(/&nbsp;/g, ' ');
		text = text.replace(/&lt;/g, '<');
		text = text.replace(/&gt;/g, '>');
		text = text.replace(/&amp;/g, '&');
		text = text.replace(/&quot;/g, '"');
		text = text.replace(/&#39;/g, "'");
		text = text.replace(/&nbsp;/g, ' ');

		// 清理多余的空白
		text = text.replace(/[ \t]+/g, ' ');
		text = text.replace(/\n\n+/g, '\n\n');
		text = text.trim();

		return text;
	}

	/**
	 * 确保浏览器连接正常，必要时重新初始化
	 * @param page 需要检查的页面，如果页面已关闭则重新创建
	 */
	private async _ensureBrowserConnected(page: puppeteer.Page): Promise<puppeteer.Page> {
		// 检查浏览器是否连接
		if (!this.browser || !this.browser.isConnected()) {
			this.logger.warn('浏览器连接已断开，正在重新初始化...');
			this.browser = await this._initializeBrowser();
			this.converterPage = null; // 重置 converterPage，稍后会重新创建
		}

		// 检查页面是否有效
		if (!page || page.isClosed()) {
			this.logger.warn('页面已关闭，正在创建新页面...');
			const newPage = await this.browser.newPage();
			// 重新创建 converterPage
			await this._ensureConverterPage();
			return newPage;
		}

		return page;
	}

	private async _markdownNormalize(
		articles: CrawledArticle[],
		userInfo: UserInfoFromToken
	): Promise<CrawledArticle[]> {
		this.logger.log(`开始净化 ${articles.length} 篇文章的Markdown内容...`);

		// 步骤1：提取所有需要格式化的代码块
		const blocksToProcess: {
			article: CrawledArticle;
			field: 'title' | 'content' | 'gist';
			match: RegExpMatchArray;
		}[] = [];

		const codeBlockRegex = /复制\n\n`([\s\S]+?)`/g;

		for (const article of articles) {
			for (const field of ['title', 'content', 'gist'] as const) {
				const matches = Array.from(article[field].matchAll(codeBlockRegex));
				for (const match of matches) {
					blocksToProcess.push({ article, field, match });
				}
			}
		}

		if (blocksToProcess.length === 0) {
			this.logger.log('没有需要格式化的代码块。');
		} else {
			this.logger.log(`共找到 ${blocksToProcess.length} 个需要格式化的代码块。`);
			// 步骤2：批量调用LLM进行转换
			const llmInputs = blocksToProcess.map(p => p.match[1]); // 提取 `([\s\S]+?)` 部分
			const BATCH_SIZE = 500;
			const CONCURRENCY_LEVEL = 50;
			const allNormalizedBlocks: string[] = [];
			const normalizeChain = await this.chainService.createMarkdownCodeBlockNormalizeChain(
				userInfo.userConfig
			);

			for (let i = 0; i < llmInputs.length; i += BATCH_SIZE) {
				const mainBatch = llmInputs.slice(i, i + BATCH_SIZE);
				this.logger.log(
					`正在处理批次 ${Math.floor(i / BATCH_SIZE) + 1}，共 ${
						mainBatch.length
					} 个代码块，llm生成任务并发数: ${CONCURRENCY_LEVEL}`
				);

				// 将大批次分割成多个子批次以进行并发处理
				const subBatches: string[][] = [];
				const subBatchSize = Math.ceil(mainBatch.length / CONCURRENCY_LEVEL);
				for (let j = 0; j < mainBatch.length; j += subBatchSize) {
					subBatches.push(mainBatch.slice(j, j + subBatchSize));
				}

				// 为每个子批次创建一个Promise
				const promises = subBatches.map((subBatch, index) => {
					this.logger.log(
						`  -> llm生成任务 #${index + 1} 已开始, 处理 ${subBatch.length} 个代码块。`
					);
					return normalizeChain.invoke({ code_blocks: subBatch });
				});

				// 并发执行所有Promise
				const settledResults = await Promise.allSettled(promises);

				// 按顺序处理结果
				const batchNormalizedBlocks: string[] = [];
				settledResults.forEach((result, index) => {
					if (result.status === 'fulfilled' && result.value?.normalized_blocks) {
						batchNormalizedBlocks.push(...result.value.normalized_blocks);
					} else {
						const failedSubBatchSize = subBatches[index].length;
						const reason =
							result.status === 'rejected' ? result.reason?.message : 'LLM返回格式错误或为空';
						this.logger.error(`  -> 并发任务 #${index + 1} 处理失败: ${reason}`);
						batchNormalizedBlocks.push(...Array(failedSubBatchSize).fill(''));
					}
				});
				allNormalizedBlocks.push(...batchNormalizedBlocks);
			}

			// 步骤3：将转换后的代码块替换回原文
			// 从后往前遍历（防御性编程，每个字符串都从后往前替换,避免替换操作影响后续要替换的字符串的索引位置）
			for (let i = blocksToProcess.length - 1; i >= 0; i--) {
				const { article, field, match } = blocksToProcess[i];
				const originalBlock = match[0];
				const normalizedBlock = allNormalizedBlocks[i];
				article[field] = article[field].replace(originalBlock, `\n${normalizedBlock}\n`);
			}
		}

		// 步骤4：标准化图片标签
		const imageRegex = /(\!\[.*?\]\(https?:\/\/.+?\))\n\n预览/g;
		for (const article of articles) {
			article.title = article.title.replace(imageRegex, '$1');
			article.content = article.content.replace(imageRegex, '$1');
			article.gist = article.gist.replace(imageRegex, '$1');
		}

		this.logger.log('Markdown内容净化完成。');
		return articles;
	}

	/**
	 * 批量保存题目信息到数据库，并过滤掉已存在的题目
	 * @param articles - 待保存的题目信息数组
	 * @returns 返回实际新保存的题目数量
	 */
	private async _saveArticles(articles: CrawledArticle[], task: CrawlTask): Promise<number> {
		if (articles.length === 0) {
			this.logger.log('没有新的题目信息需要保存。');
			return 0;
		}
		this.logger.log(`准备保存 ${articles.length} 条题目信息到数据库...`);

		const articleLinks = articles.map(a => a.link);

		//实际_getQuestionCategoriesAndUrls中已经通过link去重过滤掉了数据库中已存在的题目
		// 1. 查找数据库中已经存在的链接
		const existingArticles = await this.dbService.article.findMany({
			where: { link: { in: articleLinks } },
			select: { link: true }
		});
		const existingLinks = new Set(existingArticles.map(a => a.link));
		this.logger.log(`数据库中已存在 ${existingLinks.size} 条题目。`);

		// 2. 过滤掉已经存在的题目
		const newArticles = articles.filter(a => !existingLinks.has(a.link));
		this.logger.log(`过滤后，有 ${newArticles.length} 条新的题目信息需要插入。`);

		// 3. 插入新的题目信息
		if (newArticles.length > 0) {
			await this.dbService.article.createMany({
				data: newArticles
			});
			this.logger.log('新的题目信息已成功存入数据库。');
		}

		await this._updateTaskProgress(task, {
			totalCount: task.metadata.progress.totalCount,
			completedCount: task.metadata.progress.completedCount + newArticles.length
		});

		return newArticles.length;
	}

	/**
	 * 规范化URL, 去掉查询参数和哈希值
	 * @param url 原始URL
	 */
	private _normalizeUrl(url: string): string {
		try {
			// 处理双斜杠问题
			let fixedUrl = url.replace(/^\/\//, '/');
			const urlObj = new URL(fixedUrl);
			return `${urlObj.origin}${urlObj.pathname}`;
		} catch (error) {
			this.logger.warn(`无效的URL格式，无法标准化: ${url}`);
			return url;
		}
	}

	/**
	 * 规范化题目分类，去掉`(数字)`并全部转为小写
	 * @param category 题目分类
	 * @returns 规范化后的题目分类
	 */
	private _normalizeCategory(category: string): string {
		//去掉`(数字)`并全部转为小写
		return category.replace(/\(\d+\)/, '').toLowerCase();
	}

	/**
	 * 不同页面设置不同的访问频率伪装
	 * @param pageType 页面类型，用于区分不同类型页面的访问延迟
	 */
	private async _simulateHumanBehavior(
		pageType: 'list' | 'detail' | 'scroll' = 'detail'
	): Promise<void> {
		let minDelay: number;
		let maxDelay: number;

		switch (pageType) {
			case 'list':
				minDelay = delayConfig.list.minDelay;
				maxDelay = delayConfig.list.maxDelay;
				break;
			case 'detail':
				minDelay = delayConfig.detail.minDelay;
				maxDelay = delayConfig.detail.maxDelay;
				break;
			case 'scroll':
				minDelay = delayConfig.scroll.minDelay;
				maxDelay = delayConfig.scroll.maxDelay;
				break;
		}

		const delay = this._generateNormalDistributionDelay(minDelay, maxDelay);
		this.logger.debug(`${pageType} 页面访问延迟伪装: ${delay}ms`);
		await new Promise(resolve => setTimeout(resolve, delay));
	}

	/**
	 * 生成正态分布的延迟时间，模拟真实用户行为
	 */
	private _generateNormalDistributionDelay(min: number, max: number): number {
		const u1 = Math.random();
		const u2 = Math.random();
		const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

		const mean = (min + max) / 2;
		const stdDev = (max - min) / 6;
		let delay = mean + z0 * stdDev;

		delay = Math.max(min, Math.min(max, delay));
		return Math.round(delay);
	}

	/**
	 * 模拟真实用户的页面交互行为
	 */
	private async _simulateUserInteraction(page: puppeteer.Page): Promise<void> {
		// 随机滚动
		const scrollActions = Math.floor(Math.random() * 3) + 1; // 1-3 次滚动
		for (let i = 0; i < scrollActions; i++) {
			const scrollHeight = Math.floor(Math.random() * 300) + 100; // 100-400px
			await page.evaluate(height => {
				window.scrollBy(0, height);
			}, scrollHeight);
			await this._simulateHumanBehavior('scroll');
		}

		// 随机鼠标移动
		const viewport = page.viewport();
		if (viewport) {
			const x = Math.floor(Math.random() * viewport.width);
			const y = Math.floor(Math.random() * viewport.height);
			await page.mouse.move(x, y);
		}
	}

	/**
	 * 保活机制：在长时间等待期间定期发送 CDP 命令防止连接超时
	 * @param page Puppeteer页面对象
	 * @param originalTimeout 原始 waitForSelector 的超时时间（毫秒）
	 */
	private async _keepAliveWhileWaiting(page: puppeteer.Page, originalTimeout: number): Promise<void> {
		const keepAliveInterval = 25000; // 每 25 秒发送一次保活命令（小于 30 秒超时）
		const startTime = Date.now();
		const elapsed = () => Date.now() - startTime;

		// 只在原始超时时间内保活
		while (elapsed() < originalTimeout) {
			await new Promise(resolve => setTimeout(resolve, keepAliveInterval));
			// 不要等待太靠近超时
			if (elapsed() >= originalTimeout - 5000) break;

			try {
				if (page && !page.isClosed()) {
					await page.evaluate(() => 1); // 简单的 CDP ping
					this.logger.debug(`保活 ping 成功 (已运行 ${elapsed()}ms)`);
				}
			} catch (e) {
				this.logger.warn('保活 ping 失败:', e);
				break;
			}
		}
	}

	/**
	 * 带保活的 waitForSelector
	 */
	private async _waitForSelectorWithKeepAlive(
		page: puppeteer.Page,
		selector: string,
		options: { timeout?: number; hidden?: boolean } = {}
	): Promise<void> {
		const timeout = options.timeout || 30000;
		// 同时启动等待和保活任务
		await Promise.all([
			page.waitForSelector(selector, options),
			this._keepAliveWhileWaiting(page, timeout)
		]);
	}

	/**
	 * 更真实的用户点击模拟
	 * @param page Puppeteer页面对象
	 * @param selector 选择器
	 * @returns 点击是否成功
	 */
	private async _realUserClick(page: puppeteer.Page, selector: string): Promise<boolean> {
		try {
			const element = await page.$(selector);
			if (!element) {
				this.logger.warn(`选择器 "${selector}" 未找到元素。`);
				return false;
			}

			// 模拟鼠标移动到元素位置
			const boundingBox = await element.boundingBox();
			if (!boundingBox) {
				this.logger.warn(`无法获取元素 "${selector}" 的边界框。`);
				return false;
			}

			const x = boundingBox.x + boundingBox.width / 2;
			const y = boundingBox.y + boundingBox.height / 2;

			// 先移动鼠标到元素位置
			await page.mouse.move(x, y);
			await this._simulateHumanBehavior('scroll'); // 添加一些延迟

			// 使用page.click替代鼠标原始操作，因为它更可靠
			await page.click(selector);

			// 稍等一下让页面响应
			await new Promise(resolve => setTimeout(resolve, 1000));
			return true;
		} catch (error) {
			this.logger.error(`点击元素失败: ${selector}`, error);
			return false;
		}
	}
}
