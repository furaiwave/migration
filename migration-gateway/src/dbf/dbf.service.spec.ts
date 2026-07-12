import { Test, TestingModule } from '@nestjs/testing';
import { DbfService } from './dbf.service';

describe('DbfService', () => {
  let service: DbfService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DbfService],
    }).compile();

    service = module.get<DbfService>(DbfService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
