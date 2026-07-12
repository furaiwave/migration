import { Test, TestingModule } from '@nestjs/testing';
import { DbfController } from './dbf.controller';

describe('DbfController', () => {
  let controller: DbfController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DbfController],
    }).compile();

    controller = module.get<DbfController>(DbfController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
