import { Inject, Injectable, Logger } from '@nestjs/common';
import * as Minio from 'minio';
@Injectable()
export class OssService {
	@Inject('OSS-CLIENT')
	private ossClient: Minio.Client;

	@Inject('OSS-PRESIGN-CLIENT')
	private presignOssClient: Minio.Client;

	private logger = new Logger();

	/**
	 * 后端上传文件到oss
	 * @param objectName 对象名(文件名)
	 * @param stream 文件流
	 * @param bucketName 桶名
	 * @returns 文件url
	 */
	async upload(objectName: string, stream: string | Buffer, bucketName = 'prisma-ai') {
		try {
			await this.ossClient.putObject(bucketName, objectName, stream);
			const url = await this.ossClient.presignedGetObject(bucketName, objectName);
			return url;
		} catch (error) {
			this.logger.error(error, 'OssService ~ upload');
			throw new Error(`Failed to upload to OSS: ${error.message}`);
		}
	}
	//检查文件是否已存在
	async checkFileExists(objectName: string, bucketName = 'prisma-ai') {
		try {
			await this.ossClient.statObject(bucketName, objectName);
			return true;
		} catch (error) {
			return false;
		}
	}

	/**
	 * 从OSS获取文件对象
	 * @param objectName 对象名(文件名)
	 * @param bucketName 桶名
	 * @returns 文件内容的Buffer
	 */
	async getObject(objectName: string, bucketName = 'prisma-ai') {
		try {
			const dataStream = await this.ossClient.getObject(bucketName, objectName);
			const chunks: Buffer[] = [];
			for await (const chunk of dataStream) {
				chunks.push(chunk);
			}
			return Buffer.concat(chunks);
		} catch (error) {
			this.logger.error(error, 'OssService ~ getObject');
			throw new Error(`Failed to get object from OSS: ${error.message}`);
		}
	}

	/**
	 * 获取预签名URL以前端直传文件到oss
	 * @param name 对象名(文件名)
	 * @param bucketName 桶名
	 * @param expire 预签名URL过期时间
	 * @returns 预签名URL
	 */
	async presignedPutObject(userId: string, name: string, bucketName = 'prisma-ai', expire = 3600) {
		try {
			if (process.env.IS_ONLINE) {
				// 1. 使用预签名客户端生成 URL
				let presignedUrl = await this.presignOssClient.presignedPutObject(
					bucketName,
					`${userId}/${name}`,
					expire
				);

				// 2. 将内部 MinIO 地址替换为前端可访问的 Nginx 代理地址
				// 内部地址可能是 http://minio-container:9000/... 或 http://nginx-container/... 取决于nginx设置的HOST
				// 替换为前端可访问的 https://ai.pinkprisma.com/oss/...
				// 使用正则匹配协议、主机和端口
				presignedUrl = presignedUrl.replace(
					/http:\/\/[^/]+/,
					process.env.OSS_HOST_URL || 'https://ai.pinkprisma.com/oss'
				);

				return presignedUrl;
			}
			// 1. 使用预签名客户端（endpoint: 'nginx-container'）生成 URL
			// 此时 URL 为 http://nginx-container/prisma-ai/...
			let presignedUrl = await this.presignOssClient.presignedPutObject(
				bucketName,
				`${userId}/${name}`,
				expire
			);

			// 2. 将 URL 中的内部主机地址替换为前端可访问的、经过 Nginx 代理的地址
			presignedUrl = presignedUrl.replace('nginx-container', 'localhost/oss');

			// 3. 返回给前端的 URL 为 http://localhost/oss/prisma-ai/...
			return presignedUrl;
		} catch (error) {
			this.logger.error(error, 'OssService ~ presignedPutObject');
			throw new Error(`Failed to generate presigned URL: ${error.message}`);
		}
	}
}
