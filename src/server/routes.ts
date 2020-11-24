import { Router } from 'express';
import config from '../config';
import { Logger, FileService } from '@ethereum-sourcify/core';
import { VerificationService } from '@ethereum-sourcify/verification';
import { ValidationService } from '@ethereum-sourcify/validation';
import FileController from './controllers/FileController';
import VerificationController from './controllers/VerificationController';

const router: Router = Router();

const fileService = new FileService(config.repository.path);
const validationService: ValidationService = new ValidationService({logger: Logger("ValidationService")});
const verificationService = new VerificationService(fileService);

const fileController = new FileController(fileService);
const verificationController: VerificationController = new VerificationController(verificationService, validationService);

router.use('/files/', fileController.registerRoutes());
router.use('/', verificationController.registerRoutes());

export default router;
